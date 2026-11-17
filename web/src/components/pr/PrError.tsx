import { Button } from "../workspace/Chrome.tsx";
import { RefreshIcon, ArrowIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { errorActions } from "../../lib/prFilesLayout.ts";

/** The error body: what could not be read, what GitHub said, and the ways out. The header above it stays. */
export function PrError({ number, message, gitHubSays, url, onRetry, onOpenGithub, onShowLocal }: {
  number: number | null; message: string; gitHubSays?: string | null; url?: string;
  onRetry: () => void; onOpenGithub?: (url: string) => void; onShowLocal?: () => void;
}) {
  const acts = errorActions({ hasUrl: !!url && !!onOpenGithub, hasLocal: !!onShowLocal });
  return (
    <div role="alert" data-testid="pr-error-card" className="prf-err">
      <h3>{number != null ? `#${number} could not be read` : "This pull request could not be read"}</h3>
      <code>{message}</code>
      {gitHubSays ? <span data-testid="pr-error-status">GitHub reports: {gitHubSays}</span> : null}
      <div className="prf-err-acts">
        {acts.includes("retry") && <Button size="regular" tone="primary" onClick={onRetry}><RefreshIcon size={ICON.sm} />Try again</Button>}
        {acts.includes("github") && <Button size="regular" onClick={() => onOpenGithub!(url!)}><ArrowIcon size={ICON.sm} />Open on GitHub</Button>}
        {acts.includes("local") && <Button size="regular" onClick={onShowLocal}>Show local</Button>}
      </div>
    </div>
  );
}
