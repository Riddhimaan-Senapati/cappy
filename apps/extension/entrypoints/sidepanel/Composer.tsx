import { useState, type KeyboardEvent } from "react";

export const SUGGESTIONS = [
  "I'm red-green colorblind",
  "Invert this page, it's too bright",
  "My wrist is in a cast, make this form easier",
  "Hide distractions",
];

type Props = { onSend: (text: string) => void };

export function Composer({ onSend }: Props) {
  const [text, setText] = useState("");

  const submit = (value: string) => {
    const message = value.trim();
    if (!message) return;
    setText("");
    onSend(message);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(text);
    }
  };

  return (
    <>
      <div className="suggestions" role="group" aria-label="Suggestions">
        {SUGGESTIONS.map((suggestion) => (
          <button type="button" key={suggestion} onClick={() => submit(suggestion)}>
            {suggestion}
          </button>
        ))}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit(text);
        }}
      >
        <textarea
          aria-label="Ask for a change"
          rows={2}
          maxLength={500}
          placeholder="Tell me what you need on this page…"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" aria-label="Send" disabled={text.trim().length === 0}>
          ↑
        </button>
      </form>
    </>
  );
}
