import React from 'react';

function InterpretationCard({ position, name, tags, description }) {
  const titleMap = {
    past: '过去 (Past)',
    present: '现在 (Present)',
    future: '将来 (Future)',
  };
  const title = titleMap[position] ?? position ?? '';
  const safeTags = Array.isArray(tags) ? tags.filter(Boolean) : [];

  return (
    <article
      className="w-full bg-transparent text-left"
      data-position={position}
      style={{ minWidth: 0 }}
    >
      <h3
        style={{
          color: '#f5deb3',
          opacity: 0.95,
          fontSize: 16,
          letterSpacing: 1.6,
          margin: 0,
          marginBottom: 4,
        }}
      >
        {title}
      </h3>

      <h2
        className="text-xl font-bold my-2"
        style={{
          color: '#e0c38c',
          fontSize: 16,
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        {name ?? '—'}
      </h2>

      <div className="flex flex-wrap gap-2 my-3">
        {safeTags.map((tag) => (
          <span
            key={`${position}-${tag}`}
            className="inline-flex items-center rounded-full border px-3 py-1 text-sm"
            style={{
              borderColor: 'rgba(218, 165, 32, 0.3)',
              color: '#e0c38c',
              background: 'rgba(218, 165, 32, 0.1)',
              boxShadow: '0 0 12px rgba(218, 165, 32, 0.12)',
              fontSize: 14,
            }}
          >
            {tag}
          </span>
        ))}
      </div>

      <p
        className="leading-relaxed"
        style={{
          color: 'rgba(247,239,216,0.88)',
          fontSize: 14,
          lineHeight: 1.8,
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        {description ?? ''}
      </p>
    </article>
  );
}

export default InterpretationCard;
