import { deadlineInfo } from "./helpers";
import { useNow } from "./clock";

export function DeadlinePill({ deadline }: { deadline?: string }) {
  useNow();
  const info = deadlineInfo(deadline);
  if (!info || info.days > 14) return null;
  const [y, m, d] = deadline!.split("-").map(Number);
  return (
    <span
      className={`pill ${info.tone}`.trim()}
      title={new Date(y, m - 1, d).toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })}
    >
      {info.label}
    </span>
  );
}
