import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BrandMark } from "../components/BrandMark";
import {
  compact,
  costLabel,
  dateLabel,
  exportCsv,
  filterEvents,
  groupEvents,
  money,
  summarize,
  toolColors,
  toolName,
  type Filters,
  type UsageEvent,
} from "./ledger";

const routes = [
  { id: "overview", label: "Overview", icon: "grid", section: "Workspace" },
  { id: "activity", label: "Activity", icon: "pulse", section: "Workspace" },
  { id: "models", label: "Models", icon: "layers", section: "Workspace" },
  { id: "projects", label: "Projects", icon: "folder", section: "Workspace" },
  { id: "accounts", label: "Accounts", icon: "users", section: "Manage" },
  { id: "sources", label: "Sources", icon: "database", section: "Manage" },
] as const;
type View = (typeof routes)[number]["id"];
type NavSection = (typeof routes)[number]["section"];
const paths: Record<string, ReactNode> = {
  chevron: <path d="m9 5 7 7-7 7" />,
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  pulse: <path d="M2 12h5l3-8 4 16 3-8h5" />,
  layers: (
    <>
      <path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5" />
    </>
  ),
  folder: (
    <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5v2" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" />
    </>
  ),
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" />
    </>
  ),
  moon: <path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z" />,
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 6 6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v1" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M7 2v6m10-6v6M3 11h18" />
    </>
  ),
  coins: (
    <>
      <ellipse cx="9" cy="6" rx="6" ry="3" />
      <path d="M3 6v7c0 3 9 4 12 1V6M3 10c0 3 12 3 12 0M16 10c7 0 7 5 0 5m-4 0v4c0 4 10 4 10 0v-6" />
    </>
  ),
  code: <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20" />,
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
};
function Icon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <svg
      className={"icon " + className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.layers}
    </svg>
  );
}
function Tool({ name }: { name: string }) {
  return (
    <span className="tool-label">
      <span className={"tool-icon color-" + (toolColors[name] ?? "blue")}>
        <Icon name={name === "codex" ? "code" : "layers"} />
      </span>
      {toolName(name)}
    </span>
  );
}
function Panel({
  title,
  detail,
  action,
  children,
  className = "",
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"panel " + className}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {detail && <p>{detail}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function Empty({ clear }: { clear?: () => void }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="search" />
      </span>
      <h3>No activity in this view</h3>
      <p>Try another tool or date range to explore the sample ledger.</p>
      {clear && (
        <button className="button secondary" onClick={clear}>
          Clear filters
        </button>
      )}
    </div>
  );
}
function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog-content">
        <div className="dialog-heading">
          <h2 id="dialog-title">{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
function Chart({
  events,
  metric,
}: {
  events: UsageEvent[];
  metric: "tokens" | "cost" | "calls";
}) {
  const months = [
    ...new Set(events.map((event) => event.at.slice(0, 7))),
  ].sort();
  const groups = groupEvents(events, (event) => event.tool);
  const totals = months.map((month) =>
    summarize(events.filter((event) => event.at.startsWith(month))),
  );
  const max = Math.max(...totals.map((total) => total[metric]), 0) || 1;
  const height = 208,
    width = 800,
    left = 48,
    bottom = 32,
    top = 15,
    plotHeight = height - bottom - top;
  const band = (width - left - 18) / Math.max(months.length, 1);
  const value = (n: number) => (metric === "cost" ? money(n) : compact(n));
  const label = (total: ReturnType<typeof summarize>) =>
    metric === "cost" ? costLabel(total) : compact(total[metric]);
  if (!events.length) return <Empty />;
  return (
    <>
      <div className="usage-chart">
        <svg
          viewBox={"0 0 " + width + " " + height}
          role="img"
          aria-label={
            "Monthly " +
            metric +
            ". " +
            months
              .map(
                (month, i) =>
                  dateLabel(month + "-01", {
                    day: undefined,
                    year: "numeric",
                  }) +
                  ": " +
                  label(totals[i]!),
              )
              .join("; ")
          }
        >
          {[0, 1, 2, 3, 4].map((tick) => (
            <g key={tick}>
              <line
                x1={left}
                x2={width - 12}
                y1={top + (plotHeight * tick) / 4}
                y2={top + (plotHeight * tick) / 4}
                className="chart-grid"
              />
              <text
                x={left - 12}
                y={top + (plotHeight * tick) / 4 + 4}
                textAnchor="end"
              >
                {value(max * (1 - tick / 4))}
              </text>
            </g>
          ))}
          {months.map((month, index) => {
            let offset = 0;
            return (
              <g key={month}>
                {groups.map((group) => {
                  const usage = summarize(
                    group.rows.filter((event) => event.at.startsWith(month)),
                  );
                  const total = usage[metric];
                  const h = (total / max) * plotHeight;
                  offset += h;
                  return total > 0 ? (
                    <rect
                      key={group.name}
                      className={
                        "chart-bar color-" + (toolColors[group.name] ?? "blue")
                      }
                      x={left + band * index + band * 0.29}
                      y={top + plotHeight - offset}
                      width={band * 0.42}
                      height={Math.max(h, 1)}
                      rx="2"
                    >
                      <title>
                        {toolName(group.name) +
                          " · " +
                          month +
                          " · " +
                          label(usage)}
                      </title>
                    </rect>
                  ) : null;
                })}
                {metric === "cost" && totals[index]!.unpriced > 0 && (
                  <text
                    x={left + band * (index + 0.5)}
                    y={top + plotHeight - offset - 8}
                    textAnchor="middle"
                  >
                    {totals[index]!.unpriced === totals[index]!.calls
                      ? "Unpriced"
                      : "Partial"}
                  </text>
                )}
                <text
                  x={left + band * (index + 0.5)}
                  y={height - 8}
                  textAnchor="middle"
                >
                  {dateLabel(month + "-01", { day: undefined })}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="chart-legend">
        {groups.map((group) => (
          <span key={group.name}>
            <i className={"color-" + (toolColors[group.name] ?? "blue")} />
            {toolName(group.name)}
          </span>
        ))}
      </div>
      {metric === "cost" && totals.some((total) => total.unpriced > 0) && (
        <p className="panel-note">
          Unpriced calls are excluded from cost. Partial totals include only
          calls with a saved price.
        </p>
      )}
      <details className="chart-data">
        <summary>View chart data</summary>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Monthly usage totals</caption>
            <thead>
              <tr>
                <th>Month</th>
                <th className="numeric">{metric}</th>
              </tr>
            </thead>
            <tbody>
              {months.map((month, i) => (
                <tr key={month}>
                  <td>{month}</td>
                  <td className="numeric">{label(totals[i]!)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
function EventTable({
  events,
  onSelect,
}: {
  events: UsageEvent[];
  onSelect: (event: UsageEvent) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">
          Recorded model calls, newest first
        </caption>
        <thead>
          <tr>
            <th>Tool / model</th>
            <th>
              Recorded at <span className="muted">UTC</span>
            </th>
            <th>Activity</th>
            <th className="numeric">Tokens</th>
            <th className="numeric">API equivalent</th>
            <th>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {[...events]
            .sort((a, b) => b.at.localeCompare(a.at))
            .map((event) => (
              <tr key={event.id}>
                <td>
                  <Tool name={event.tool} />
                  <span className="row-secondary">{event.model}</span>
                </td>
                <td>
                  <span>{dateLabel(event.at, { year: "numeric" })}</span>
                  <span className="row-secondary mono">
                    {new Date(event.at).toISOString().slice(11, 19)}
                  </span>
                </td>
                <td>
                  <span
                    className={
                      "badge " +
                      (event.kind === "subagent" ? "pink" : "neutral")
                    }
                  >
                    {event.kind === "subagent" ? "Subagent" : "Main session"}
                  </span>
                </td>
                <td className="numeric mono">
                  {compact(summarize([event]).tokens)}
                </td>
                <td
                  className={
                    "numeric mono " + (event.cost === null ? "muted" : "")
                  }
                >
                  {money(event.cost)}
                </td>
                <td>
                  <button
                    className="icon-button"
                    aria-label={
                      "View " + toolName(event.tool) + " call " + event.id
                    }
                    onClick={() => onSelect(event)}
                  >
                    <Icon name="arrow" />
                  </button>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
const pageCopy: Record<View, { title: string; subtitle: string }> = {
  overview: {
    title: "Your AI, accounted for.",
    subtitle: "Understand your usage. See where the work goes.",
  },
  activity: {
    title: "Every call has a story.",
    subtitle: "Explore recorded calls, sessions, and agent activity.",
  },
  models: {
    title: "The tools behind the work.",
    subtitle: "Compare model usage, token volume, and estimated cost.",
  },
  projects: {
    title: "Where your tokens go.",
    subtitle: "Follow usage back to the projects that generated it.",
  },
  accounts: {
    title: "A clearer view of cost.",
    subtitle: "Keep subscription fees and API-equivalent usage in perspective.",
  },
  sources: {
    title: "Know what’s included.",
    subtitle: "Understand the coverage and limitations behind your numbers.",
  },
};
export function UsageDashboard({ events }: { events: UsageEvent[] }) {
  const [view, setView] = useState<View>("overview");
  const [collapsed, setCollapsed] = useState<Record<NavSection, boolean>>({
    Workspace: false,
    Manage: false,
  });
  const [filters, setFilters] = useState<Filters>({
    tool: "all",
    since: "",
    until: "",
  });
  const [period, setPeriod] = useState("all");
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<string | null>(null);
  const [metric, setMetric] = useState<"tokens" | "cost" | "calls">("tokens");
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("modex-usage-theme") === "light"
        ? "light"
        : "dark";
    } catch {
      return "dark";
    }
  });
  const [selected, setSelected] = useState<UsageEvent | null>(null);
  const [custom, setCustom] = useState(false);
  const [notice, setNotice] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const previousView = useRef(view);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add("theme-changing");
    root.dataset.theme = theme;
    void root.offsetHeight;
    const frame = requestAnimationFrame(() =>
      root.classList.remove("theme-changing"),
    );
    try {
      localStorage.setItem("modex-usage-theme", theme);
    } catch {
      /* The view also works without persistence. */
    }
    return () => {
      cancelAnimationFrame(frame);
      root.classList.remove("theme-changing");
    };
  }, [theme]);
  useEffect(() => {
    if (previousView.current !== view) {
      heading.current?.focus();
      previousView.current = view;
    }
  }, [view]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const filtered = useMemo(
    () => filterEvents(events, filters),
    [events, filters],
  );
  const visible = filtered.filter(
    (event) =>
      (project === null || (event.project || "?") === project) &&
      [event.model, toolName(event.tool), event.project, event.session].some(
        (text) => text.toLowerCase().includes(query.toLowerCase()),
      ),
  );
  const total = summarize(filtered);
  const all = useMemo(() => summarize(events), [events]);
  const tools = groupEvents(filtered, (event) => event.tool);
  const months = [
    ...new Set(events.map((event) => event.at.slice(0, 7))),
  ].sort();
  const first = [...events].sort((a, b) => a.at.localeCompare(b.at))[0]?.at;
  const last = [...events].sort((a, b) => b.at.localeCompare(a.at))[0]?.at;
  const range = filters.since
    ? dateLabel(filters.since) +
      " – " +
      dateLabel(filters.until, { year: "numeric" })
    : first && last
      ? dateLabel(first) + " – " + dateLabel(last, { year: "numeric" })
      : "No recorded activity";
  const clear = () => {
    setFilters({ tool: "all", since: "", until: "" });
    setPeriod("all");
    setQuery("");
    setProject(null);
  };
  const navigate = (next: View) => {
    const section = routes.find((route) => route.id === next)!.section;
    setCollapsed((current) => ({ ...current, [section]: false }));
    setView(next);
    setQuery("");
    setProject(null);
  };
  const exportRows = () => {
    const url = URL.createObjectURL(
      new Blob([exportCsv(visible)], { type: "text/csv;charset=utf-8;" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "modex-usage-sample.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(
      "CSV ready: " +
        visible.length +
        " sample calls. Check your browser downloads.",
    );
  };
  return (
    <div className="usage-app">
      <a className="skip-link" href="#usage-main">
        Skip to usage
      </a>
      <aside className="sidebar">
        <a
          className="brand"
          href="#overview"
          onClick={(event) => {
            event.preventDefault();
            navigate("overview");
          }}
        >
          <BrandMark />
          <span>
            modex<span className="brand-byline">by TypeSafe</span>
          </span>
        </a>
        <nav aria-label="Usage navigation">
          {(["Workspace", "Manage"] as const).map((section) => (
            <div className="nav-group" key={section}>
              <button
                className="nav-caption"
                aria-expanded={!collapsed[section]}
                aria-controls={"nav-" + section.toLowerCase()}
                onClick={() =>
                  setCollapsed((current) => ({
                    ...current,
                    [section]: !current[section],
                  }))
                }
              >
                <span>{section}</span>
                <span className="nav-group-context" aria-hidden="true">
                  {collapsed[section] &&
                  routes.find((route) => route.id === view)?.section === section
                    ? routes.find((route) => route.id === view)?.label
                    : routes.filter((route) => route.section === section)
                        .length}
                </span>
                <Icon name="chevron" />
              </button>
              <div
                id={"nav-" + section.toLowerCase()}
                className={
                  "nav-group-items" +
                  (collapsed[section] ? " is-collapsed" : "")
                }
              >
                {routes
                  .filter((route) => route.section === section)
                  .map((route) => (
                    <button
                      key={route.id}
                      className={
                        "nav-link " + (view === route.id ? "selected" : "")
                      }
                      aria-current={view === route.id ? "page" : undefined}
                      onClick={() => navigate(route.id)}
                    >
                      <Icon name={route.icon} />
                      <span>{route.label}</span>
                      {route.id === "activity" && (
                        <span className="nav-count">{events.length}</span>
                      )}
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="demo-stamp">
            <span className="demo-kicker">
              <span />
              Interactive preview
            </span>
            <strong>
              <span>Demo</span> <span>Data</span>
            </strong>
            <span className="demo-caption">
              {compact(events.length)} sample calls ·{" "}
              {new Set(events.map((event) => event.tool)).size} sources
            </span>
          </div>
          <button
            className="nav-link theme-switch"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
            {theme === "dark" ? "Light appearance" : "Dark appearance"}
            <span className="keycap">◐</span>
          </button>
          <div className="sidebar-foot">
            <span>Modex Usage</span>
            <span className="mono">Preview</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <Icon name="pulse" />
            <span>Workspace</span>
            <span className="slash">/</span>
            <strong>{routes.find((route) => route.id === view)?.label}</strong>
          </div>
          <div className="topbar-status">
            <span className="status-dot" />
            Sample workspace<span className="avatar">M</span>
            <button
              className="icon-button mobile-theme"
              aria-label={
                theme === "dark"
                  ? "Use light appearance"
                  : "Use dark appearance"
              }
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
          </div>
        </header>
        <main id="usage-main" className="main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span />
                USAGE & INSIGHTS
              </div>
              <h1 tabIndex={-1} ref={heading}>
                {pageCopy[view].title}
              </h1>
              <p>{pageCopy[view].subtitle}</p>
            </div>
            <button className="button primary" onClick={exportRows}>
              <Icon name="download" />
              Export CSV
            </button>
          </div>
          <div className="sample-banner">
            <Icon name="info" />
            <p>
              <strong>Demo Data.</strong> A fictional workspace with{" "}
              {events.length} calls across{" "}
              {new Set(events.map((event) => event.tool)).size} sources.
              Illustrative estimates; no accounts connected.
            </p>
            <button onClick={() => navigate("sources")}>
              View coverage
              <Icon name="arrow" />
            </button>
          </div>
          <div className="filterbar">
            <div className="filters">
              <label className="select-control">
                <Icon name="calendar" />
                <span className="sr-only">Date range</span>
                <select
                  aria-label="Date range"
                  value={period}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "custom") {
                      setCustom(true);
                      return;
                    }
                    setPeriod(value);
                    const until =
                      value === "all"
                        ? ""
                        : new Date(
                            Date.UTC(
                              Number(value.slice(0, 4)),
                              Number(value.slice(5, 7)),
                              0,
                            ),
                          )
                            .toISOString()
                            .slice(0, 10);
                    setFilters((current) => ({
                      ...current,
                      since: value === "all" ? "" : value + "-01",
                      until,
                    }));
                  }}
                >
                  <option value="all">All time</option>
                  {months.map((month) => (
                    <option key={month} value={month}>
                      {dateLabel(month + "-01", {
                        day: undefined,
                        year: "numeric",
                      })}
                    </option>
                  ))}
                  <option value="custom">
                    Custom range{period === "custom" ? " · applied" : "…"}
                  </option>
                </select>
              </label>
              <label className="select-control">
                <Icon name="layers" />
                <span className="sr-only">Tool</span>
                <select
                  aria-label="Tool"
                  value={filters.tool}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      tool: event.target.value,
                    }))
                  }
                >
                  <option value="all">All tools</option>
                  {[...new Set(events.map((event) => event.tool))]
                    .sort()
                    .map((tool) => (
                      <option key={tool} value={tool}>
                        {toolName(tool)}
                      </option>
                    ))}
                </select>
              </label>
              {period === "custom" && (
                <button className="text-button" onClick={() => setCustom(true)}>
                  Edit dates
                </button>
              )}
              {(period !== "all" || filters.tool !== "all") && (
                <button className="text-button" onClick={clear}>
                  Reset
                </button>
              )}
            </div>
            <span className="date-caption mono">
              {range}
              <span>UTC</span>
            </span>
          </div>

          {view === "overview" && (
            <>
              <div className="metrics">
                <article className="metric">
                  <div className="metric-label">
                    Total tokens
                    <Icon name="layers" />
                  </div>
                  <div className="metric-value">{compact(total.tokens)}</div>
                  <div className="metric-foot">
                    <span className="teal-text">{compact(total.output)}</span>{" "}
                    output tokens
                    <span className="mini-track">
                      <i
                        style={{
                          width: total.tokens
                            ? (total.output / total.tokens) * 100 + "%"
                            : "0%",
                        }}
                      />
                    </span>
                  </div>
                </article>
                <article className="metric">
                  <div className="metric-label">
                    API-equivalent cost
                    <Icon name="coins" />
                  </div>
                  <div
                    className={
                      "metric-value " +
                      (total.calls > 0 && total.unpriced === total.calls
                        ? "unpriced-value"
                        : "")
                    }
                  >
                    {total.calls > 0 && total.unpriced === total.calls
                      ? "Unpriced"
                      : money(total.cost)}
                  </div>
                  <div className="metric-foot">
                    <span className="dot amber" />
                    {total.unpriced
                      ? total.unpriced + " calls unpriced"
                      : "All calls priced"}
                    <span className="muted"> · estimate</span>
                  </div>
                </article>
                <article className="metric">
                  <div className="metric-label">
                    Model calls
                    <Icon name="pulse" />
                  </div>
                  <div className="metric-value">
                    {total.calls}
                    <span className="value-unit">calls</span>
                  </div>
                  <div className="metric-foot">
                    {total.sessions} sessions
                    <span className="separator">·</span>
                    {total.activeDays} active days
                  </div>
                </article>
                <article className="metric">
                  <div className="metric-label">
                    Prompt cache hit rate
                    <Icon name="database" />
                  </div>
                  <div className="metric-value">
                    {total.hitRate.toFixed(1)}
                    <span className="value-unit">%</span>
                  </div>
                  <div className="metric-foot">
                    <span className="teal-text">{money(total.saved)}</span>{" "}
                    estimated cache savings
                  </div>
                </article>
              </div>
              <div className="overview-grid">
                <Panel
                  title="Usage over time"
                  detail="Monthly activity across your selected tools"
                  className="trend-panel"
                  action={
                    <div className="segmented" aria-label="Chart metric">
                      {(["tokens", "cost", "calls"] as const).map((value) => (
                        <button
                          key={value}
                          aria-pressed={metric === value}
                          className={metric === value ? "active" : ""}
                          onClick={() => setMetric(value)}
                        >
                          {value === "cost"
                            ? "Cost"
                            : value === "tokens"
                              ? "Tokens"
                              : "Calls"}
                        </button>
                      ))}
                    </div>
                  }
                >
                  <Chart events={filtered} metric={metric} />
                </Panel>
                <Panel
                  title="Token breakdown"
                  detail="What makes up your usage"
                  className="breakdown-panel"
                >
                  <div className="token-composition">
                    <div className="composition-value">
                      {compact(total.tokens)}
                      <span>total tokens</span>
                    </div>
                    <div
                      className="composition-track"
                      role="img"
                      aria-label={
                        "Uncached input " +
                        total.input +
                        ", cache reads " +
                        total.cached +
                        ", cache writes " +
                        total.cacheWrite +
                        ", output " +
                        total.output
                      }
                    >
                      {[
                        ["pink", total.input],
                        ["teal", total.cached],
                        ["amber", total.cacheWrite],
                        ["blue", total.output],
                      ].map(([color, value]) => (
                        <span
                          key={color}
                          className={"color-" + color}
                          style={{ flex: Number(value) }}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="breakdown-list">
                    {[
                      ["Uncached input", total.input, "pink"],
                      ["Cache reads", total.cached, "teal"],
                      ["Cache writes", total.cacheWrite, "amber"],
                      ["Output", total.output, "blue"],
                    ].map(([label, value, color]) => (
                      <div key={label}>
                        <span>
                          <i className={"dot color-" + color} />
                          {label}
                        </span>
                        <strong className="mono">
                          {compact(Number(value))}
                        </strong>
                        <span className="mono">
                          {total.tokens
                            ? ((Number(value) / total.tokens) * 100).toFixed(1)
                            : "0.0"}
                          %
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="panel-note">
                    Reasoning is included in output tokens.
                  </p>
                </Panel>
                <Panel
                  title="Tools at a glance"
                  detail="Ranked by token volume"
                  action={
                    <button
                      className="text-button"
                      onClick={() => navigate("models")}
                    >
                      View all
                      <Icon name="arrow" />
                    </button>
                  }
                >
                  <div className="tool-rank">
                    {tools.slice(0, 5).map((tool) => (
                      <button
                        key={tool.name}
                        onClick={() => {
                          setFilters((current) => ({
                            ...current,
                            tool: tool.name,
                          }));
                          navigate("models");
                        }}
                      >
                        <Tool name={tool.name} />
                        <span className="rank-track">
                          <i
                            className={
                              "color-" + (toolColors[tool.name] ?? "blue")
                            }
                            style={{
                              width: total.tokens
                                ? (tool.tokens / total.tokens) * 100 + "%"
                                : "0%",
                            }}
                          />
                        </span>
                        <span className="mono">{compact(tool.tokens)}</span>
                        <span className="muted mono">
                          {total.tokens
                            ? ((tool.tokens / total.tokens) * 100).toFixed(0)
                            : 0}
                          %
                        </span>
                      </button>
                    ))}
                    {!tools.length && <Empty clear={clear} />}
                  </div>
                </Panel>
                <Panel
                  title="A note on your numbers"
                  detail="Useful context, alongside the totals"
                  className="insight-panel"
                >
                  <div className="insight-icon">
                    <Icon name="shield" />
                  </div>
                  <h3>
                    Explore the patterns. <br />
                    Keep the gaps visible.
                  </h3>
                  <p>
                    Demo prices show how estimates work. Unpriced calls still
                    count as activity; they don’t silently become free usage.
                  </p>
                  <button
                    className="text-button"
                    onClick={() => navigate("accounts")}
                  >
                    Understand your costs
                    <Icon name="arrow" />
                  </button>
                </Panel>
              </div>
              <Panel
                title="Recent activity"
                detail={
                  "Latest " + Math.min(filtered.length, 4) + " recorded calls"
                }
                action={
                  <button
                    className="text-button"
                    onClick={() => navigate("activity")}
                  >
                    All activity
                    <Icon name="arrow" />
                  </button>
                }
              >
                {filtered.length ? (
                  <EventTable
                    events={[...filtered]
                      .sort((a, b) => b.at.localeCompare(a.at))
                      .slice(0, 4)}
                    onSelect={setSelected}
                  />
                ) : (
                  <Empty clear={clear} />
                )}
              </Panel>
            </>
          )}

          {["activity", "models", "projects"].includes(view) && (
            <div className="results-toolbar">
              <label className="search">
                <Icon name="search" />
                <input
                  aria-label="Search usage"
                  placeholder="Search models, tools, or projects…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query && (
                  <button
                    className="icon-button"
                    aria-label="Clear search"
                    onClick={() => setQuery("")}
                  >
                    <Icon name="close" />
                  </button>
                )}
              </label>
              <span className="muted">
                {visible.length} calls · {compact(summarize(visible).tokens)}{" "}
                tokens
              </span>
            </div>
          )}
          {view === "activity" && project !== null && (
            <div className="project-filter">
              <Icon name="folder" />
              <span>{project === "?" ? "Unattributed project" : project}</span>
              <button
                className="icon-button"
                aria-label="Clear project filter"
                onClick={() => setProject(null)}
              >
                <Icon name="close" />
              </button>
            </div>
          )}
          {view === "activity" && (
            <Panel
              title="Recorded activity"
              detail="Select a call to inspect its usage and attribution"
            >
              {visible.length ? (
                <EventTable events={visible} onSelect={setSelected} />
              ) : (
                <Empty clear={clear} />
              )}
            </Panel>
          )}
          {view === "models" && (
            <Panel
              title="Models"
              detail="Token totals include cached input. Demo prices are illustrative, not current rates."
            >
              {visible.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Tool</th>
                        <th>Share of tokens</th>
                        <th className="numeric">Calls</th>
                        <th className="numeric">Tokens</th>
                        <th className="numeric">Cache hit rate</th>
                        <th className="numeric">API equivalent</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupEvents(
                        visible,
                        (event) => event.tool + ":" + event.model,
                      ).map((group) => (
                        <tr key={group.name}>
                          <td className="mono">{group.rows[0]?.model}</td>
                          <td>
                            <Tool name={group.rows[0]!.tool} />
                          </td>
                          <td>
                            <div className="share-cell">
                              <span className="rank-track">
                                <i
                                  className="color-pink"
                                  style={{
                                    width:
                                      (group.tokens /
                                        Math.max(
                                          summarize(visible).tokens,
                                          1,
                                        )) *
                                        100 +
                                      "%",
                                  }}
                                />
                              </span>
                              <span className="mono">
                                {(
                                  (group.tokens /
                                    Math.max(summarize(visible).tokens, 1)) *
                                  100
                                ).toFixed(1)}
                                %
                              </span>
                            </div>
                          </td>
                          <td className="numeric mono">{group.calls}</td>
                          <td className="numeric mono">
                            {compact(group.tokens)}
                          </td>
                          <td className="numeric mono">
                            {group.hitRate.toFixed(1)}%
                          </td>
                          <td className="numeric mono">
                            {group.unpriced === group.calls
                              ? "Unpriced"
                              : money(group.cost)}
                            {group.unpriced > 0 &&
                              group.unpriced < group.calls && (
                                <span className="row-secondary">
                                  Partially priced
                                </span>
                              )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty clear={clear} />
              )}
            </Panel>
          )}
          {view === "projects" && (
            <Panel
              title="Working directories"
              detail="Sample paths are retained for attribution. Unknown paths stay unattributed."
            >
              {visible.length ? (
                <div className="project-grid">
                  {groupEvents(visible, (event) => event.project || "?").map(
                    (group) => (
                      <article className="project-card" key={group.name}>
                        <span className="project-icon">
                          <Icon name="folder" />
                        </span>
                        <h3>
                          {group.name === "?"
                            ? "Unattributed project"
                            : group.name.split("/").pop()}
                        </h3>
                        <p className="mono">
                          {group.name === "?"
                            ? "No working directory recorded"
                            : group.name}
                        </p>
                        <div className="project-stats">
                          <span>
                            <strong>{compact(group.tokens)}</strong>tokens
                          </span>
                          <span>
                            <strong>{group.sessions}</strong>sessions
                          </span>
                          <span>
                            <strong>
                              {group.unpriced === group.calls
                                ? "—"
                                : money(group.cost)}
                            </strong>
                            API equivalent
                            {group.unpriced > 0 && (
                              <span className="row-secondary">
                                {group.unpriced === group.calls
                                  ? "Unpriced"
                                  : "Partially priced"}
                              </span>
                            )}
                          </span>
                        </div>
                        <button
                          className="text-button"
                          onClick={() => {
                            navigate("activity");
                            setProject(group.name);
                          }}
                        >
                          Explore calls
                          <Icon name="arrow" />
                        </button>
                      </article>
                    ),
                  )}
                </div>
              ) : (
                <Empty clear={clear} />
              )}
            </Panel>
          )}
          {view === "accounts" && (
            <>
              <div className="account-notice">
                <Icon name="info" />
                <div>
                  <h2>API equivalent is not your bill.</h2>
                  <p>
                    Subscriptions, measured token activity, and provider quotas
                    are separate. This preview has no billing connection or live
                    quota information.
                  </p>
                </div>
              </div>
              <Panel
                title="Account attribution"
                detail="Account mappings from the synthetic ledger; scoped to the current filters."
              >
                <div className="account-grid">
                  {groupEvents(filtered, (event) => event.account).map(
                    (group) => (
                      <article className="account-card" key={group.name}>
                        <span className="account-icon">
                          <Icon name="users" />
                        </span>
                        <span className="badge neutral">Sample</span>
                        <h3>
                          {group.name === "unattributed"
                            ? "Unattributed usage"
                            : group.name.startsWith("codex")
                              ? "ChatGPT"
                              : group.name.startsWith("claude")
                                ? "Claude"
                                : group.name.startsWith("github")
                                  ? "GitHub Copilot"
                                  : group.name.startsWith("gemini")
                                    ? "Gemini"
                                    : group.name}
                        </h3>
                        <p className="mono">{group.name}</p>
                        <div className="account-value">
                          {group.unpriced === group.calls
                            ? "Unpriced"
                            : money(group.cost)}
                          <span>API-equivalent usage</span>
                        </div>
                        <dl>
                          <div>
                            <dt>Recorded calls</dt>
                            <dd>{group.calls}</dd>
                          </div>
                          <div>
                            <dt>Total tokens</dt>
                            <dd>{compact(group.tokens)}</dd>
                          </div>
                          <div>
                            <dt>Unpriced calls</dt>
                            <dd>{group.unpriced}</dd>
                          </div>
                          <div>
                            <dt>Quota remaining</dt>
                            <dd className="muted">Unavailable</dd>
                          </div>
                        </dl>
                      </article>
                    ),
                  )}
                </div>
                {!filtered.length && <Empty clear={clear} />}
              </Panel>
              <Panel
                title="Reading cost estimates"
                detail="Demo rates illustrate the calculation; they are not current provider prices."
              >
                <div className="explanation-grid">
                  <div>
                    <Icon name="coins" />
                    <h3>Price by token category</h3>
                    <p>
                      Input, cached input, cache writes, and output can have
                      different rates. Service-tier premiums may not be
                      represented.
                    </p>
                  </div>
                  <div>
                    <Icon name="calendar" />
                    <h3>Keep time windows aligned</h3>
                    <p>
                      A partial month of logged activity doesn’t prove the value
                      of a whole subscription. Monthly fees aren’t allocated to
                      these calls.
                    </p>
                  </div>
                  <div>
                    <Icon name="info" />
                    <h3>Leave gaps visible</h3>
                    <p>
                      Unpriced calls still count toward tokens and activity.
                      Their cost is excluded from the API-equivalent total.
                    </p>
                  </div>
                </div>
              </Panel>
            </>
          )}
          {view === "sources" && (
            <>
              <div className="source-summary">
                <span className="source-check">
                  <Icon name="check" />
                </span>
                <div>
                  <h2>A complete demo. Clear boundaries.</h2>
                  <p>
                    {all.calls} synthetic calls · {all.sessions} sessions ·{" "}
                    {new Set(events.map((event) => event.tool)).size} sources ·{" "}
                    {first && dateLabel(first, { year: "numeric" })}–
                    {last && dateLabel(last, { year: "numeric" })}
                  </p>
                </div>
                <span className="badge teal">Sample records</span>
              </div>
              <Panel
                title="Demo sources"
                detail="Examples for exploring the dashboard, not connected integrations. Counts cover the full demo."
              >
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Tool</th>
                        <th>Source</th>
                        <th className="numeric">Calls</th>
                        <th className="numeric">Tokens</th>
                        <th>Pricing</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupEvents(events, (event) => event.tool).map(
                        (group) => (
                          <tr key={group.name}>
                            <td>
                              <Tool name={group.name} />
                            </td>
                            <td className="muted">Local synthetic fixture</td>
                            <td className="numeric mono">{group.calls}</td>
                            <td className="numeric mono">
                              {compact(group.tokens)}
                            </td>
                            <td>
                              <span
                                className={
                                  "badge " +
                                  (group.unpriced ? "amber" : "neutral")
                                }
                              >
                                {group.unpriced
                                  ? group.unpriced === group.calls
                                    ? "Unpriced"
                                    : "Partial estimate"
                                  : "Demo estimate"}
                              </span>
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>
              <Panel title="What this demo shows">
                <div className="explanation-grid">
                  <div>
                    <Icon name="shield" />
                    <h3>No personal data</h3>
                    <p>
                      Prompts, credentials, and personal transcripts are not
                      part of this preview. No provider accounts are connected.
                    </p>
                  </div>
                  <div>
                    <Icon name="database" />
                    <h3>Gaps stay visible</h3>
                    <p>
                      Unpriced calls and unattributed projects are intentional.
                      The workload, model mix, and prices are fictional
                      examples, not a benchmark or a prediction of your bill.
                    </p>
                  </div>
                  <div>
                    <Icon name="layers" />
                    <h3>Understand token totals</h3>
                    <p>
                      Total tokens combine uncached input, cache reads, cache
                      writes, and output. Reasoning is included in output, not
                      added again.
                    </p>
                  </div>
                </div>
              </Panel>
              <Panel
                title="GitHub Copilot"
                detail="A demo source, ready to explore with the tool filter."
              >
                <p className="panel-note">
                  These synthetic sessions illustrate token usage. Copilot
                  billing units and subscription allowances are separate from
                  API-equivalent USD, so these calls remain unpriced. No GitHub
                  account is connected and no Copilot usage is imported.{" "}
                  <a
                    href="https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing"
                    target="_blank"
                    rel="noreferrer"
                  >
                    About Copilot usage reporting ↗
                  </a>
                </p>
              </Panel>
              <p className="attribution">
                Demo scenarios expanded from synthetic fixtures in{" "}
                <a
                  href="https://github.com/CompleteTech-LLC/ai-usage-ledger-skill"
                  target="_blank"
                  rel="noreferrer"
                >
                  AI Usage Ledger
                </a>{" "}
                by CompleteTech LLC, MIT licensed. Interface follows{" "}
                <a href="https://ui.jev.works" target="_blank" rel="noreferrer">
                  TypeSafe UI
                </a>
                .
              </p>
            </>
          )}
          <footer className="footer">
            <span>
              <Icon name="shield" />
              Sample data stays in your browser
            </span>
            <span>
              Estimates in USD<span className="separator">·</span>Dates in UTC
              <span className="separator">·</span>
              <a href="https://ui.jev.works" target="_blank" rel="noreferrer">
                TypeSafe UI
                <Icon name="arrow" />
              </a>
            </span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" />
          {notice}
        </div>
      )}
      {selected && (
        <Dialog title="Call details" onClose={() => setSelected(null)}>
          <Tool name={selected.tool} />
          <p className="detail-model mono">{selected.model}</p>
          <dl className="detail-list">
            {[
              ["Recorded at", new Date(selected.at).toISOString()],
              ["Session", selected.session],
              [
                "Project",
                !selected.project || selected.project === "?"
                  ? "Unattributed"
                  : selected.project,
              ],
              ["Account", selected.account],
              ["Activity", selected.kind],
              ["Uncached input", compact(selected.input)],
              ["Cache reads", compact(selected.cached)],
              ["Cache writes", compact(selected.cacheWrite)],
              ["Output (includes reasoning)", compact(selected.output)],
              ["Reasoning subset", compact(selected.reasoning)],
              ["API equivalent", money(selected.cost)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="panel-note">
            Synthetic record. Cost uses an illustrative demo rate, not a current
            price or charge.
          </p>
        </Dialog>
      )}
      {custom && (
        <Dialog title="Choose a date range" onClose={() => setCustom(false)}>
          <form
            className="date-form"
            onChange={(event) =>
              event.currentTarget
                .querySelector<HTMLInputElement>('[name="until"]')
                ?.setCustomValidity("")
            }
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              const since = String(data.get("since")),
                until = String(data.get("until"));
              if (since > until) {
                form
                  .querySelector<HTMLInputElement>('[name="until"]')!
                  .setCustomValidity(
                    "End date must be on or after the start date.",
                  );
                form.reportValidity();
                return;
              }
              setFilters((current) => ({ ...current, since, until }));
              setPeriod("custom");
              setCustom(false);
            }}
          >
            <p>
              Both dates are inclusive. Sample activity runs from January to
              September 2026. Dates use UTC.
            </p>
            <label>
              Start date
              <input
                type="date"
                name="since"
                required
                defaultValue={filters.since || first?.slice(0, 10)}
              />
            </label>
            <label>
              End date
              <input
                type="date"
                name="until"
                required
                defaultValue={filters.until || last?.slice(0, 10)}
                onChange={(event) => event.target.setCustomValidity("")}
              />
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setCustom(false)}
              >
                Cancel
              </button>
              <button className="button primary" type="submit">
                Apply range
                <Icon name="arrow" />
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
