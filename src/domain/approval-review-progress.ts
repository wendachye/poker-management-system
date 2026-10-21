import type { ApprovalRequest } from "./model";

/** Presentation only; final approval remains enforced by domain operations. */
export function approvalReviewProgress(
  request: Pick<ApprovalRequest, "approvalLevel" | "status" | "votes">,
  translate: (text: string) => string = (text) => text,
) {
  const reviewers = Array.from(
    new Map(request.votes.map((vote) => [vote.staffId, vote])).values(),
  );
  const minimum = request.approvalLevel === "DUAL" ? 2 : 1;
  const needsAdmin =
    request.approvalLevel !== "MANAGER" &&
    !reviewers.some((vote) => vote.role === "ADMIN");
  const requirement =
    request.status !== "PENDING"
      ? null
      : needsAdmin
        ? "Admin review required"
        : reviewers.length < minimum
          ? "Awaiting independent review"
          : null;
  return {
    reviewers,
    count: reviewers.length,
    minimum,
    requirement,
    label: [
      `${translate("Reviewers")}: ${reviewers.length}`,
      `${translate("Minimum required")}: ${minimum}`,
      requirement ? translate(requirement) : "",
    ]
      .filter(Boolean)
      .join(" · "),
  };
}
