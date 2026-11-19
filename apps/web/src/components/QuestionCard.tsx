import type { TimelineItem, UserQuestion } from "@wooky/contracts";
import { memo, useState } from "react";
import {
  buildQuestionAnswers,
  emptyDraft,
  questionSummary,
  type QuestionDraft,
} from "../lib/question-answers.ts";
import { dismissQuestion, respondQuestion } from "../state/actions.ts";

type Item = Extract<TimelineItem, { kind: "question" }>;

export const QuestionCard = memo(function QuestionCard({
  item,
  threadId,
}: {
  item: Item;
  threadId: string;
}) {
  const open = item.answers === null && !item.dismissed;
  if (!open && (item.answers || item.dismissed)) {
    const summary = item.answers
      ? questionSummary(item.questions, item.answers)
      : questionSummary(item.questions, {}, true);
    return (
      <p className="question-summary" aria-label={`Question: ${summary}`}>
        {summary}
      </p>
    );
  }
  return <OpenQuestion item={item} threadId={threadId} />;
});

function OpenQuestion({ item, threadId }: { item: Item; threadId: string }) {
  const [draft, setDraft] = useState<QuestionDraft>(() => emptyDraft(item.questions));
  const [busy, setBusy] = useState(false);
  const complete = buildQuestionAnswers(item.questions, draft) !== null;

  const setSelected = (question: UserQuestion, label: string, checked: boolean) => {
    setDraft((state) => {
      const entry = state[question.id] ?? { selected: [], other: "" };
      if (question.multiSelect) {
        const selected = checked
          ? [...entry.selected, label]
          : entry.selected.filter((value) => value !== label);
        return { ...state, [question.id]: { ...entry, selected } };
      }
      return { ...state, [question.id]: { ...entry, selected: checked ? [label] : [] } };
    });
  };

  const submit = async () => {
    const answers = buildQuestionAnswers(item.questions, draft);
    if (!answers || busy) return;
    setBusy(true);
    const ack = await respondQuestion(threadId, item.requestId, answers);
    setBusy(false);
    if (!ack) setBusy(false);
  };

  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    await dismissQuestion(threadId, item.requestId);
    setBusy(false);
  };

  return (
    <section className="question pending" aria-label="Agent question">
      <p className="question-eyebrow">Waiting for you</p>
      {item.questions.map((question) => (
        <QuestionGroup
          key={question.id}
          question={question}
          entry={draft[question.id] ?? { selected: [], other: "" }}
          onSelect={(label, checked) => setSelected(question, label, checked)}
          onOther={(other) =>
            setDraft((state) => ({
              ...state,
              [question.id]: { ...(state[question.id] ?? { selected: [], other: "" }), other },
            }))
          }
        />
      ))}
      <div className="question-actions">
        <button type="button" className="button" disabled={busy} onClick={() => void dismiss()}>
          Dismiss
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!complete || busy}
          title={!complete ? "Answer every question before submitting" : undefined}
          onClick={() => void submit()}
        >
          Submit
        </button>
      </div>
    </section>
  );
}

function QuestionGroup({
  question,
  entry,
  onSelect,
  onOther,
}: {
  question: UserQuestion;
  entry: { selected: string[]; other: string };
  onSelect: (label: string, checked: boolean) => void;
  onOther: (value: string) => void;
}) {
  const group = question.header ?? question.question;
  const Input = question.multiSelect ? "checkbox" : "radio";
  const name = `question-${question.id}`;
  return (
    <fieldset className="question-group">
      <legend className="question-header">{group}</legend>
      <p className="question-text">{question.question}</p>
      <div
        className="question-options"
        role={question.multiSelect ? "group" : "radiogroup"}
        aria-label={group}
      >
        {question.options.map((option) => {
          const checked = entry.selected.includes(option.label);
          return (
            <label key={option.label} className="question-option">
              <input
                type={Input}
                name={question.multiSelect ? `${name}-${option.label}` : name}
                checked={checked}
                onChange={(event) => onSelect(option.label, event.target.checked)}
              />
              <span className="question-option-copy">
                <span className="question-option-label">{option.label}</span>
                {option.description ? (
                  <span className="question-option-desc">{option.description}</span>
                ) : null}
              </span>
            </label>
          );
        })}
        {question.allowCustom ? (
          <label className="question-option other">
            <span className="question-option-label">Other</span>
            <input
              type="text"
              value={entry.other}
              aria-label="Other answer"
              placeholder="Type your answer"
              onChange={(event) => onOther(event.target.value)}
            />
          </label>
        ) : null}
      </div>
    </fieldset>
  );
}
