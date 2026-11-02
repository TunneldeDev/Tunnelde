import { useTranslation } from "react-i18next";
import { Copy } from "lucide-react";
import { IconButton } from "@/components/ui/form/Button";
import { groupChatMessages, type ChatMessage } from "@/lib/plugins/pluginChat";
import { copyText } from "@/lib/session/clipboard";
import { PluginMarkdown } from "./PluginMarkdown";

export function PluginChatMessages({
  messages,
  title,
  active,
}: {
  messages: ChatMessage[];
  title: string;
  active: boolean;
}) {
  const { t } = useTranslation();
  const turns = groupChatMessages(messages);
  const message = (item: ChatMessage) => (
    <article className={`plugin-chat__message is-${item.role}`} key={item.id}>
      <div className="plugin-chat__message-head">
        <strong>{item.role === "assistant" ? title : t(`pluginChat.roles.${item.role}`)}</strong>
        <IconButton
          size="sm"
          label={t("pluginChat.copyMessage")}
          onClick={() => void copyText(item.content)}
        >
          <Copy size={12} />
        </IconButton>
      </div>
      {item.role === "assistant" ? (
        <PluginMarkdown source={item.content} />
      ) : (
        <div className="plugin-chat__plain">{item.content}</div>
      )}
    </article>
  );
  return turns.map((turn, index) => (
    <section className="plugin-chat__turn" key={turn.id}>
      {turn.user && message(turn.user)}
      {!!turn.activity.length && (
        <details className="plugin-chat__process">
          <summary>
            <span>
              {active && index === turns.length - 1
                ? t("pluginChat.activityRunning")
                : t("pluginChat.process")}
            </span>
            <small>{t("pluginChat.steps", { count: turn.activity.length })}</small>
          </summary>
          <div className="plugin-chat__process-body">
            {turn.activity.map((item) => (
              <details className="plugin-chat__tool-output" key={item.id}>
                <summary>
                  {item.title ||
                    (item.kind === "reasoning"
                      ? t("pluginChat.reasoning")
                      : item.kind === "tool"
                        ? t("pluginChat.toolOutput")
                        : title)}
                  {item.status && ["error", "failed", "cancelled"].includes(item.status) && (
                    <small>{item.status}</small>
                  )}
                </summary>
                <div className="plugin-chat__message-head">
                  <IconButton
                    size="sm"
                    label={t("pluginChat.copyToolOutput")}
                    onClick={() => void copyText(item.content)}
                  >
                    <Copy size={12} />
                  </IconButton>
                </div>
                {item.kind === "tool" ? (
                  <pre tabIndex={0}>{item.content}</pre>
                ) : (
                  <PluginMarkdown source={item.content} />
                )}
              </details>
            ))}
          </div>
        </details>
      )}
      {turn.reply?.content && message(turn.reply)}
      {turn.notices.map(message)}
    </section>
  ));
}
