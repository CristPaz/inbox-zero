import prisma from "@/utils/prisma";
import { ThreadTrackerType } from "@prisma/client";
import type { gmail_v1 } from "@googleapis/gmail";
import {
  labelNeedsReply,
  removeAwaitingReplyLabel,
  getReplyTrackingLabels,
} from "@/utils/reply-tracker/label";
import { createScopedLogger } from "@/utils/logger";
import type { UserEmailWithAI } from "@/utils/llms/types";
import type { User } from "@prisma/client";
import type { ParsedMessage } from "@/utils/types";
import { internalDateToDate } from "@/utils/date";
import { getEmailForLLM } from "@/utils/ai/choose-rule/get-email-from-message";
import { aiChooseRule } from "@/utils/ai/choose-rule/ai-choose-rule";
import { getReplyTrackingRule } from "@/utils/reply-tracker";

const logger = createScopedLogger("reply-tracker/inbound");

export async function markNeedsReply(
  userId: string,
  threadId: string,
  messageId: string,
  sentAt: Date,
  gmail: gmail_v1.Gmail,
) {
  const { awaitingReplyLabelId, needsReplyLabelId } =
    await getReplyTrackingLabels(gmail);

  const dbPromise = prisma.$transaction([
    // Resolve existing AWAITING trackers
    prisma.threadTracker.updateMany({
      where: {
        userId,
        threadId,
        type: ThreadTrackerType.AWAITING,
      },
      data: {
        resolved: true,
      },
    }),
    // Create new NEEDS_REPLY tracker
    prisma.threadTracker.upsert({
      where: {
        userId_threadId_messageId: {
          userId,
          threadId,
          messageId,
        },
      },
      update: {},
      create: {
        userId,
        threadId,
        messageId,
        type: ThreadTrackerType.NEEDS_REPLY,
        sentAt,
      },
    }),
  ]);

  const removeLabelPromise = removeAwaitingReplyLabel(
    gmail,
    threadId,
    awaitingReplyLabelId,
  );
  const newLabelPromise = labelNeedsReply(gmail, messageId, needsReplyLabelId);

  const [dbResult, removeLabelResult, newLabelResult] =
    await Promise.allSettled([dbPromise, removeLabelPromise, newLabelPromise]);

  const errorOptions = {
    userId,
    threadId,
    messageId,
  };

  if (dbResult.status === "rejected") {
    logger.error("Failed to mark needs reply", {
      ...errorOptions,
      error: dbResult.reason,
    });
  }

  if (removeLabelResult.status === "rejected") {
    logger.error("Failed to remove awaiting reply label", {
      ...errorOptions,
      error: removeLabelResult.reason,
    });
  }

  if (newLabelResult.status === "rejected") {
    logger.error("Failed to label needs reply", {
      ...errorOptions,
      error: newLabelResult.reason,
    });
  }
}

// Currently this is used when enabling reply tracking. Otherwise we use regular AI rule processing to handle inbound replies
export async function handleInboundReply(
  user: Pick<User, "id" | "about"> & UserEmailWithAI,
  message: ParsedMessage,
  gmail: gmail_v1.Gmail,
) {
  // 1. Run rules check
  // 2. If the reply tracking rule is selected then mark as needs reply
  // We ignore the rest of the actions for this rule here as this could lead to double handling of emails for the user

  const replyTrackingRule = await getReplyTrackingRule(user.id);

  if (!replyTrackingRule?.instructions) return;

  const result = await aiChooseRule({
    email: getEmailForLLM(message),
    rules: [
      {
        id: replyTrackingRule.id,
        instructions: replyTrackingRule.instructions,
      },
    ],
    user,
  });

  if (result.rule?.id === replyTrackingRule.id) {
    await markNeedsReply(
      user.id,
      message.threadId,
      message.id,
      internalDateToDate(message.internalDate),
      gmail,
    );
  }
}
