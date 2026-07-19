import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Loader2, Plus, RefreshCw, Save, Server, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import { cn } from '../../../../lib/utils';
import type { SettingsProject } from '../../types/types';

type Scope = 'global' | 'project';

type McpConfigFile = {
  exists: boolean;
  path: string;
  raw: string;
  config: { mcpServers?: Record<string, unknown> };
};

type McpConfigResponse = {
  global: McpConfigFile;
  project: McpConfigFile;
};

type KeyValueRow = {
  id: string;
  key: string;
  value: string;
};

type McpServerForm = {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  env: KeyValueRow[];
  envPassThrough: string[];
  perSession: boolean;
  url: string;
  headers: KeyValueRow[];
};

const EMPTY_CONFIG = JSON.stringify({ mcpServers: {} }, null, 2);
const INPUT_CLASS = 'h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring';

const STDIO_TEMPLATE = {
  command: 'npx',
  args: ['-y', 'some-mcp-server'],
  env: {
    API_KEY: '${env:API_KEY}',
  },
};

const REMOTE_TEMPLATE = {
  url: 'https://example.com/mcp',
  headers: {
    Authorization: 'Bearer ${env:MCP_TOKEN}',
  },
};

export default function McpServersTab({ projects = [] }: { projects?: SettingsProject[] }) {
  const { t } = useTranslation('settings');
  const projectOptions = useMemo(() => {
    return projects
      .map((project) => ({
        label: project.displayName || project.name || project.fullPath || project.path || '',
        value: project.fullPath || project.path || '',
      }))
      .filter((project) => project.value);
  }, [projects]);
  const [projectPath, setProjectPath] = useState(projectOptions[0]?.value ?? '');
  const [scope, setScope] = useState<Scope>('global');
  const [configs, setConfigs] = useState<McpConfigResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<Scope, string>>({ global: EMPTY_CONFIG, project: EMPTY_CONFIG });
  const [serverDrafts, setServerDrafts] = useState<Record<Scope, McpServerForm[]>>({ global: [], project: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!projectPath && projectOptions[0]?.value) {
      setProjectPath(projectOptions[0].value);
    }
  }, [projectOptions, projectPath]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const query = projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : '';
      const response = await authenticatedFetch(`/api/mcp/config${query}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.details || data.error || 'Failed to load MCP config');
      setConfigs({ global: data.global, project: data.project });
      setDrafts({ global: data.global.raw, project: data.project.raw });
      setServerDrafts({
        global: parseServers(data.global.raw).servers,
        project: parseServers(data.project.raw).servers,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load MCP config');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const activeConfig = configs?.[scope];
  const activeDraft = drafts[scope];
  const activeServers = serverDrafts[scope];
  const parsedError = useMemo(() => parseServers(activeDraft).error, [activeDraft]);
  const serverCount = activeServers.length;

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      if (activeServers.some((server) => server.name.trim().length === 0)) {
        throw new Error(t('mcpConfig.nameRequired'));
      }
      const raw = stringifyServers(activeServers);
      const response = await authenticatedFetch(`/api/mcp/config/${scope}`, {
        method: 'PUT',
        body: JSON.stringify({ raw, projectPath }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.details || data.error || 'Failed to save MCP config');
      setConfigs((current) => current ? { ...current, [scope]: data } : current);
      setDrafts((current) => ({ ...current, [scope]: data.raw }));
      setServerDrafts((current) => ({ ...current, [scope]: parseServers(data.raw).servers }));
      setMessage(t('mcpConfig.saved'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save MCP config');
    } finally {
      setSaving(false);
    }
  };

  const updateServers = (servers: McpServerForm[]) => {
    setServerDrafts((current) => ({ ...current, [scope]: servers }));
    setDrafts((current) => ({ ...current, [scope]: stringifyServers(servers) }));
  };

  const updateServer = (serverId: string, patch: Partial<McpServerForm>) => {
    updateServers(activeServers.map((server) => server.id === serverId ? { ...server, ...patch } : server));
  };

  const addTemplate = (kind: 'stdio' | 'remote') => {
    try {
      const parsed = JSON.parse(activeDraft || EMPTY_CONFIG);
      const mcpServers = parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
      const baseName = kind === 'stdio' ? 'new-stdio-server' : 'new-remote-server';
      let candidate = baseName;
      let index = 2;
      while (mcpServers[candidate]) {
        candidate = `${baseName}-${index}`;
        index += 1;
      }
      const nextServer = formFromRaw(candidate, kind === 'stdio' ? STDIO_TEMPLATE : REMOTE_TEMPLATE);
      updateServers([...activeServers, nextServer]);
    } catch {
      setError(t('mcpConfig.fixJsonBeforeTemplate'));
    }
  };

  const removeServer = (serverId: string) => {
    updateServers(activeServers.filter((server) => server.id !== serverId));
  };

  const updateAdvancedJson = (value: string) => {
    setDrafts((current) => ({ ...current, [scope]: value }));
    const parsed = parseServers(value);
    if (!parsed.error) {
      setServerDrafts((current) => ({ ...current, [scope]: parsed.servers }));
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-card/60 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <Server className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="text-sm font-semibold text-foreground">{t('mcpConfig.title')}</div>
              <div className="text-xs leading-5 text-muted-foreground">{t('mcpConfig.description')}</div>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            {t('pilotDeckConfig.actions.refresh')}
          </Button>
        </div>
      </div>

      {projectOptions.length > 0 && (
        <label className="block space-y-2">
          <span className="text-xs font-medium text-muted-foreground">{t('mcpConfig.project')}</span>
          <select
            value={projectPath}
            onChange={(event) => setProjectPath(event.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
          >
            {projectOptions.map((project) => (
              <option key={project.value} value={project.value}>
                {project.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex rounded-lg border border-border bg-muted/40 p-1">
        {(['global', 'project'] as Scope[]).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setScope(item)}
            disabled={item === 'project' && !projectPath}
            className={cn(
              'flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              scope === item ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              item === 'project' && !projectPath && 'cursor-not-allowed opacity-50',
            )}
          >
            {t(`mcpConfig.scopes.${item}`)}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-border bg-card/60">
        <div className="flex flex-col gap-3 border-b border-border p-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              {t('mcpConfig.serverCount', { count: serverCount })}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {activeConfig?.path || t('mcpConfig.noPath')}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => addTemplate('stdio')}>
              <Plus className="h-4 w-4" />
              {t('mcpConfig.addStdio')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => addTemplate('remote')}>
              <Plus className="h-4 w-4" />
              {t('mcpConfig.addRemote')}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('pilotDeckConfig.loading')}
          </div>
        ) : parsedError ? (
          <div className="space-y-4 p-4">
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {parsedError}
            </div>
            <AdvancedJsonEditor
              value={activeDraft}
              onChange={updateAdvancedJson}
            />
          </div>
        ) : (
          <div className="space-y-4 p-4">
            {activeServers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                {t('mcpConfig.empty')}
              </div>
            ) : (
              activeServers.map((server) => (
                <ServerFormCard
                  key={server.id}
                  server={server}
                  onChange={(patch) => updateServer(server.id, patch)}
                  onRemove={() => removeServer(server.id)}
                />
              ))
            )}
            <AdvancedJsonEditor
              value={activeDraft}
              onChange={updateAdvancedJson}
            />
          </div>
        )}
      </div>

      {(error || message) && (
        <div className={cn('rounded-lg border px-4 py-3 text-sm', error ? 'border-destructive/40 text-destructive' : 'border-border text-muted-foreground')}>
          {error || message}
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={() => void save()} disabled={saving || loading || (scope === 'project' && !projectPath)}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {t('pilotDeckConfig.actions.saveAndReload')}
        </Button>
      </div>
    </div>
  );
}

function ServerFormCard({
  server,
  onChange,
  onRemove,
}: {
  server: McpServerForm;
  onChange: (patch: Partial<McpServerForm>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('settings');
  const summary = server.transport === 'stdio'
    ? [server.command, ...server.args].filter(Boolean).join(' ')
    : server.url;
  const shouldOpenByDefault = server.name.startsWith('new-stdio-server') || server.name.startsWith('new-remote-server');
  const [isOpen, setIsOpen] = useState(shouldOpenByDefault);

  return (
    <details
      className="overflow-hidden rounded-lg border border-border bg-background"
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer list-none px-4 py-3 transition-colors hover:bg-accent/25 [&::-webkit-details-marker]:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-foreground">{server.name || t('mcpConfig.unnamed')}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold uppercase text-muted-foreground">
                {server.transport === 'stdio' ? 'STDIO' : t('mcpConfig.transport.http')}
              </span>
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{summary || t('mcpConfig.noSummary')}</div>
          </div>
          <span className="text-xs font-medium text-muted-foreground">{t('mcpConfig.expand')}</span>
        </div>
      </summary>

      <div className="space-y-4 border-t border-border p-4">
        <Field label={t('mcpConfig.fields.name')}>
          <input
            value={server.name}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="MCP server name"
            className={INPUT_CLASS}
          />
        </Field>

        <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-muted/40 p-1">
          <ToggleButton
            active={server.transport === 'stdio'}
            onClick={() => onChange({ transport: 'stdio' })}
          >
            STDIO
          </ToggleButton>
          <ToggleButton
            active={server.transport === 'http'}
            onClick={() => onChange({ transport: 'http' })}
          >
            {t('mcpConfig.transport.http')}
          </ToggleButton>
        </div>

        {server.transport === 'stdio' ? (
          <div className="space-y-4">
            <Field label={t('mcpConfig.fields.command')}>
              <input
                value={server.command}
                onChange={(event) => onChange({ command: event.target.value })}
                placeholder="npx"
                className={INPUT_CLASS}
              />
            </Field>

            <StringListEditor
              label={t('mcpConfig.fields.args')}
              values={server.args}
              placeholder="-y"
              addLabel={t('mcpConfig.actions.addArg')}
              onChange={(args) => onChange({ args })}
            />

            <KeyValueEditor
              label={t('mcpConfig.fields.env')}
              rows={server.env}
              keyPlaceholder={t('mcpConfig.placeholders.key')}
              valuePlaceholder={t('mcpConfig.placeholders.value')}
              addLabel={t('mcpConfig.actions.addEnv')}
              onChange={(env) => onChange({ env })}
            />

            <StringListEditor
              label={t('mcpConfig.fields.envPassThrough')}
              values={server.envPassThrough}
              placeholder="GITHUB_TOKEN"
              addLabel={t('mcpConfig.actions.addVariable')}
              onChange={(envPassThrough) => onChange({ envPassThrough })}
            />

            <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
              <span>
                <span className="block text-sm font-medium text-foreground">{t('mcpConfig.fields.perSession')}</span>
                <span className="block text-xs text-muted-foreground">{t('mcpConfig.fields.perSessionHelp')}</span>
              </span>
              <input
                type="checkbox"
                checked={server.perSession}
                onChange={(event) => onChange({ perSession: event.target.checked })}
                className="h-4 w-4"
              />
            </label>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label={t('mcpConfig.fields.url')}>
              <input
                value={server.url}
                onChange={(event) => onChange({ url: event.target.value })}
                placeholder="https://example.com/mcp"
                className={INPUT_CLASS}
              />
            </Field>
            <KeyValueEditor
              label={t('mcpConfig.fields.headers')}
              rows={server.headers}
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer ${env:MCP_TOKEN}"
              addLabel={t('mcpConfig.actions.addHeader')}
              onChange={(headers) => onChange({ headers })}
            />
          </div>
        )}
      </div>

      <div className="flex justify-end border-t border-border bg-muted/20 px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onRemove} className="text-destructive hover:text-destructive">
          <Trash2 className="h-4 w-4" />
          {t('pilotDeckConfig.actions.remove')}
        </Button>
      </div>
    </details>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

function ToggleButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-2 text-sm font-semibold transition-colors',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function StringListEditor({
  label,
  values,
  placeholder,
  addLabel,
  onChange,
}: {
  label: string;
  values: string[];
  placeholder: string;
  addLabel: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <div className="space-y-2">
        {values.map((value, index) => (
          <div key={index} className="flex gap-2">
            <input
              value={value}
              onChange={(event) => onChange(values.map((entry, i) => i === index ? event.target.value : entry))}
              placeholder={placeholder}
              className={INPUT_CLASS}
            />
            <IconButton onClick={() => onChange(values.filter((_, i) => i !== index))} />
          </div>
        ))}
        <Button variant="secondary" size="sm" className="w-full" onClick={() => onChange([...values, ''])}>
          <Plus className="h-4 w-4" />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

function KeyValueEditor({
  label,
  rows,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  onChange,
}: {
  label: string;
  rows: KeyValueRow[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  onChange: (rows: KeyValueRow[]) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <input
              value={row.key}
              onChange={(event) => onChange(rows.map((entry) => entry.id === row.id ? { ...entry, key: event.target.value } : entry))}
              placeholder={keyPlaceholder}
              className={INPUT_CLASS}
            />
            <input
              value={row.value}
              onChange={(event) => onChange(rows.map((entry) => entry.id === row.id ? { ...entry, value: event.target.value } : entry))}
              placeholder={valuePlaceholder}
              className={INPUT_CLASS}
            />
            <IconButton onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))} />
          </div>
        ))}
        <Button variant="secondary" size="sm" className="w-full" onClick={() => onChange([...rows, { id: newId(), key: '', value: '' }])}>
          <Plus className="h-4 w-4" />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

function IconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
}

function AdvancedJsonEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation('settings');

  return (
    <details className="rounded-lg border border-border bg-background">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-foreground">
        {t('mcpConfig.advanced')}
      </summary>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        className="min-h-[260px] w-full resize-y border-t border-border bg-background p-4 font-mono text-xs leading-5 text-foreground outline-none"
      />
    </details>
  );
}

function parseServers(raw: string): { servers: McpServerForm[]; error?: string } {
  try {
    const parsed = JSON.parse(raw || EMPTY_CONFIG);
    const mcpServers = parsed?.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers as Record<string, unknown>
      : {};
    return {
      servers: Object.entries(mcpServers).map(([name, value], index) => formFromRaw(name, value, String(index))),
    };
  } catch (error) {
    return { servers: [], error: error instanceof Error ? error.message : 'Invalid JSON' };
  }
}

function formFromRaw(name: string, value: unknown, id = newId()): McpServerForm {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const env = toKeyValueRows(raw.env);
  const envPassThrough = env
    .filter((row) => row.value === `\${env:${row.key}}`)
    .map((row) => row.key);

  return {
    id,
    name,
    transport: typeof raw.command === 'string' ? 'stdio' : 'http',
    command: typeof raw.command === 'string' ? raw.command : '',
    args: Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === 'string') : [],
    env: env.filter((row) => row.value !== `\${env:${row.key}}`),
    envPassThrough,
    perSession: raw.perSession === true,
    url: typeof raw.url === 'string' ? raw.url : typeof raw.httpUrl === 'string' ? raw.httpUrl : '',
    headers: toKeyValueRows(raw.headers),
  };
}

function stringifyServers(servers: McpServerForm[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    const name = server.name.trim();
    if (!name) continue;
    if (server.transport === 'stdio') {
      const env = Object.fromEntries([
        ...server.env.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]),
        ...server.envPassThrough.filter(Boolean).map((key) => [key.trim(), `\${env:${key.trim()}}`]),
      ]);
      mcpServers[name] = {
        command: server.command,
        ...(server.args.filter(Boolean).length > 0 ? { args: server.args.filter(Boolean) } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(server.perSession ? { perSession: true } : {}),
      };
    } else {
      const headers = Object.fromEntries(server.headers.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]));
      mcpServers[name] = {
        url: server.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
    }
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

function toKeyValueRows(value: unknown): KeyValueRow[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, rowValue]) => ({
    id: newId(),
    key,
    value: typeof rowValue === 'string' ? rowValue : String(rowValue ?? ''),
  }));
}

function newId() {
  return Math.random().toString(36).slice(2);
}
