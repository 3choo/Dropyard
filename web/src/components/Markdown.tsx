import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

export function Markdown({ source }: { source: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(source ?? '', { async: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [source]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
