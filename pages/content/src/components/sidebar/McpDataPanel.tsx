import React from 'react';
import { Typography, Icon } from './ui';
import { Button } from '@src/components/ui/button';

interface ResourceItem {
  name?: string;
  uri?: string;
  description?: string;
}

interface PromptItem {
  name?: string;
  description?: string;
}

interface ServerInfo {
  name?: string;
  title?: string;
  version?: string;
  description?: string;
}

interface McpDataPanelProps {
  serverInfo?: ServerInfo;
  serverInstructions?: string;
  resources: ResourceItem[];
  prompts: PromptItem[];
  onRefresh: () => Promise<void> | void;
  isRefreshing?: boolean;
}

const SectionHeader: React.FC<{ icon: 'server' | 'box' | 'file-text'; title: string; count?: number }> = ({
  icon,
  title,
  count,
}) => {
  return (
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-2">
        <Icon name={icon} size="sm" className="text-slate-600 dark:text-slate-300" />
        <Typography variant="subtitle" className="text-slate-800 dark:text-slate-100">
          {title}
        </Typography>
      </div>
      {typeof count === 'number' ? (
        <span className="text-xs text-slate-500 dark:text-slate-400">{count}</span>
      ) : null}
    </div>
  );
};

const McpDataPanel: React.FC<McpDataPanelProps> = ({
  serverInfo,
  serverInstructions,
  resources,
  prompts,
  onRefresh,
  isRefreshing = false,
}) => {
  const hasData = Boolean(serverInstructions?.trim()) || resources.length > 0 || prompts.length > 0 || Boolean(serverInfo?.name || serverInfo?.title);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <Typography variant="h4" className="text-slate-900 dark:text-slate-100">
          MCP Data
        </Typography>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onRefresh()}
          disabled={isRefreshing}
          className="border-slate-300 dark:border-slate-600">
          <Icon name="refresh" size="xs" className={isRefreshing ? 'animate-spin mr-1' : 'mr-1'} />
          {isRefreshing ? 'Refreshing' : 'Refresh'}
        </Button>
      </div>

      <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-md p-3">
        <SectionHeader icon="server" title="Server" />
        <div className="text-sm text-slate-700 dark:text-slate-300 space-y-1">
          <div>Name: {serverInfo?.title || serverInfo?.name || 'Unknown'}</div>
          <div>Version: {serverInfo?.version || 'Unknown'}</div>
          {serverInfo?.description ? <div>Description: {serverInfo.description}</div> : null}
        </div>
      </div>

      <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-md p-3">
        <SectionHeader icon="file-text" title="Server Instructions" />
        <pre className="whitespace-pre-wrap break-words text-xs text-slate-700 dark:text-slate-300 max-h-52 overflow-y-auto">
          {serverInstructions?.trim() || 'No instructions provided by MCP server.'}
        </pre>
      </div>

      <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-md p-3">
        <SectionHeader icon="box" title="Resources" count={resources.length} />
        {resources.length === 0 ? (
          <Typography variant="caption" className="text-slate-500 dark:text-slate-400">
            No resources advertised.
          </Typography>
        ) : (
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {resources.map((resource, index) => (
              <div key={`${resource.uri || resource.name || 'resource'}-${index}`} className="text-xs p-2 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                <div className="font-medium text-slate-800 dark:text-slate-200">{resource.name || 'Unnamed resource'}</div>
                {resource.uri ? (
                  <a
                    href={resource.uri}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-600 dark:text-indigo-400 break-all hover:underline">
                    {resource.uri}
                  </a>
                ) : null}
                {resource.description ? (
                  <div className="text-slate-600 dark:text-slate-400 mt-1">{resource.description}</div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-md p-3">
        <SectionHeader icon="file-text" title="Prompts" count={prompts.length} />
        {prompts.length === 0 ? (
          <Typography variant="caption" className="text-slate-500 dark:text-slate-400">
            No prompts advertised.
          </Typography>
        ) : (
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {prompts.map((prompt, index) => (
              <div key={`${prompt.name || 'prompt'}-${index}`} className="text-xs p-2 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                <div className="font-medium text-slate-800 dark:text-slate-200">{prompt.name || 'Unnamed prompt'}</div>
                {prompt.description ? (
                  <div className="text-slate-600 dark:text-slate-400 mt-1">{prompt.description}</div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {!hasData ? (
        <Typography variant="caption" className="text-slate-500 dark:text-slate-400 block">
          Connect to an MCP server and click Refresh to load metadata.
        </Typography>
      ) : null}
    </div>
  );
};

export default McpDataPanel;
