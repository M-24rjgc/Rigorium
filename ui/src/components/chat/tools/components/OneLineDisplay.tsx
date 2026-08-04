import React, { useState } from 'react';
import { copyTextToClipboard } from '../../../../utils/clipboard';

/**
 * Icon-name → SVG path map (24×24 stroke-based, matches the inline SVGs
 * used elsewhere in this component). Tool configs reference icons by name
 * (map/eye/file-text/book/image/search/terminal); anything not in the map
 * falls back to rendering the raw string so unknown configs stay readable.
 */
const ICON_PATHS: Record<string, string> = {
  terminal: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  map: 'M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7',
  eye: 'M15 12a3 3 0 11-6 0 3 3 0 016 0zM2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
  'file-text': 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  book: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
  image: 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z',
  search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
};

type ActionType = 'copy' | 'open-file' | 'jump-to-results' | 'none';

interface OneLineDisplayProps {
  toolName: string;
  icon?: string;
  label?: string;
  value: string;
  secondary?: string;
  action?: ActionType;
  onAction?: () => void;
  style?: string;
  wrapText?: boolean;
  colorScheme?: {
    primary?: string;
    secondary?: string;
    background?: string;
    border?: string;
    icon?: string;
  };
  resultId?: string;
  toolResult?: any;
  toolId?: string;
}

/**
 * Unified one-line display for simple tool inputs and results
 * Used by: Bash, Read, Grep/Glob (minimized), TodoRead, etc.
 */
export const OneLineDisplay: React.FC<OneLineDisplayProps> = ({
  toolName,
  icon,
  label,
  value,
  secondary,
  action = 'none',
  onAction,
  style,
  wrapText = false,
  colorScheme = {
    primary: 'text-gray-700 dark:text-gray-300',
    secondary: 'text-gray-500 dark:text-gray-400',
    background: '',
    border: 'border-gray-300 dark:border-gray-600',
    icon: 'text-gray-500 dark:text-gray-400'
  },
  toolResult,
  toolId
}) => {
  const [copied, setCopied] = useState(false);
  const isTerminal = style === 'terminal';

  const handleAction = async () => {
    if (action === 'copy' && value) {
      const didCopy = await copyTextToClipboard(value);
      if (!didCopy) {
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else if (onAction) {
      onAction();
    }
  };

  const renderCopyButton = () => (
    <button
      onClick={handleAction}
      className="ml-1 flex-shrink-0 text-gray-400 opacity-0 transition-all hover:text-gray-600 group-hover:opacity-100 dark:hover:text-gray-200"
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <svg className="h-3 w-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );

  // Terminal style: dark pill only around the command
  if (isTerminal) {
    return (
      <div className="group my-1">
        <div className="flex items-start gap-2">
          <div className="flex flex-shrink-0 items-center gap-1.5 pt-0.5">
            <svg className="h-3 w-3 text-green-500 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <div className="min-w-0 flex-1 rounded bg-gray-900 px-2.5 py-1 dark:bg-black">
              <code className={`font-mono text-xs text-green-400 ${wrapText ? 'whitespace-pre-wrap break-all' : 'block truncate'}`}>
                <span className="select-none text-green-600 dark:text-green-500">$ </span>{value}
              </code>
            </div>
            {action === 'copy' && renderCopyButton()}
          </div>
        </div>
        {secondary && (
          <div className="ml-7 mt-1">
            <span className="text-[11px] italic text-gray-400 dark:text-gray-500">
              {secondary}
            </span>
          </div>
        )}
      </div>
    );
  }

  // File open style - show filename only, full path on hover
  if (action === 'open-file') {
    const displayName = value.split('/').pop() || value;
    return (
      <div className={`group flex items-center gap-1.5 border-l-2 ${colorScheme.border} my-0.5 py-0.5 pl-3`}>
        <span className="flex-shrink-0 text-xs text-gray-500 dark:text-gray-400">{label || toolName}</span>
        <span className="text-[10px] text-gray-300 dark:text-gray-600">/</span>
        <button
          onClick={handleAction}
          className="truncate font-mono text-xs text-blue-600 transition-colors hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
          title={value}
        >
          {displayName}
        </button>
      </div>
    );
  }

  // Search / jump-to-results style
  if (action === 'jump-to-results') {
    return (
      <div className={`group flex items-center gap-1.5 border-l-2 ${colorScheme.border} my-0.5 py-0.5 pl-3`}>
        <span className="flex-shrink-0 text-xs text-gray-500 dark:text-gray-400">{label || toolName}</span>
        <span className="text-[10px] text-gray-300 dark:text-gray-600">/</span>
        <span className={`min-w-0 flex-1 truncate font-mono text-xs ${colorScheme.primary}`}>
          {value}
        </span>
        {secondary && (
          <span className="flex-shrink-0 text-[11px] italic text-gray-400 dark:text-gray-500">
            {secondary}
          </span>
        )}
        {toolResult && (
          <a
            href={`#tool-result-${toolId}`}
            className="flex flex-shrink-0 items-center gap-0.5 text-[11px] text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </a>
        )}
      </div>
    );
  }

  // Default one-line style
  return (
    <div className={`group flex items-center gap-1.5 ${colorScheme.background || ''} border-l-2 ${colorScheme.border} my-0.5 py-0.5 pl-3`}>
      {icon && (
        <span className={`${colorScheme.icon} flex-shrink-0`}>
          {ICON_PATHS[icon] ? (
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={ICON_PATHS[icon]} />
            </svg>
          ) : (
            <span className="text-xs">{icon}</span>
          )}
        </span>
      )}
      {!icon && (label || toolName) && (
        <span className="flex-shrink-0 text-xs text-gray-500 dark:text-gray-400">{label || toolName}</span>
      )}
      {(icon || label || toolName) && (
        <span className="text-[10px] text-gray-300 dark:text-gray-600">/</span>
      )}
      <span className={`font-mono text-xs ${wrapText ? 'whitespace-pre-wrap break-all' : 'truncate'} min-w-0 flex-1 ${colorScheme.primary}`}>
        {value}
      </span>
      {secondary && (
        <span className={`text-[11px] ${colorScheme.secondary} flex-shrink-0 italic`}>
          {secondary}
        </span>
      )}
      {action === 'copy' && renderCopyButton()}
    </div>
  );
};
