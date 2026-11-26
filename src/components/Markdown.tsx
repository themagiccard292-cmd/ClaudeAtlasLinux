import { type ReactNode, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { IconCheck, IconCopy } from './Icons';

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs text-muted">
        <span className="font-mono">{lang || 'text'}</span>
        <button onClick={copy} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-line/60 hover:text-ink">
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed"><code>{code}</code></pre>
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-atlas">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children: kids }: { children?: ReactNode }) {
            return <>{kids}</>;
          },
          code({ className, children: kids }: { className?: string; children?: ReactNode }) {
            const text = String(kids ?? '').replace(/\n$/, '');
            const lang = /language-(\w+)/.exec(className ?? '')?.[1];
            if (lang || text.includes('\n')) return <CodeBlock lang={lang ?? ''} code={text} />;
            return <code>{kids}</code>;
          },
          a({ href, children: kids }: { href?: string; children?: ReactNode }) {
            return <a href={href} target="_blank" rel="noreferrer">{kids}</a>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
