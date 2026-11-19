import { memo, useState, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "../lib/markdown.ts";
import { IconCheck, IconCopy } from "./Icons.tsx";
import { Tooltip } from "./Tooltip.tsx";

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md chat-markdown">{parseMarkdown(text).map(renderBlock)}</div>;
});

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.type) {
    case "paragraph":
      return <p key={index}>{renderInlines(block.children)}</p>;
    case "heading": {
      const Tag = `h${block.level + 2 > 6 ? 6 : block.level + 2}` as "h3" | "h4" | "h5" | "h6";
      return <Tag key={index}>{renderInlines(block.children)}</Tag>;
    }
    case "code":
      return <CodeBlock key={index} lang={block.lang} text={block.text} />;
    case "list": {
      const items = block.items.map((item, i) => <li key={i}>{renderInlines(item)}</li>);
      return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    case "quote":
      return <blockquote key={index}>{renderInlines(block.children)}</blockquote>;
    case "rule":
      return <hr key={index} />;
  }
}

function renderInlines(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "strong":
        return <strong key={index}>{renderInlines(node.children)}</strong>;
      case "em":
        return <em key={index}>{renderInlines(node.children)}</em>;
      case "link":
        return (
          <a key={index} href={node.href} target="_blank" rel="noreferrer noopener">
            {renderInlines(node.children)}
          </a>
        );
    }
  });
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div className="code-block chat-markdown-codeblock">
      <div className="code-head">
        <span>{lang || "text"}</span>
        <Tooltip label={copied ? "Copied" : "Copy code"}>
          <button
            type="button"
            className="icon-button"
            aria-label={copied ? "Copied" : "Copy code"}
            onClick={copy}
            onBlur={() => setCopied(false)}
          >
            {copied ? <IconCheck /> : <IconCopy />}
          </button>
        </Tooltip>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
