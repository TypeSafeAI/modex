import { useRef, useState } from "react";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { Icon } from "../components/ui/Icon";
import { PLUGIN_MARKS } from "./plugin-marks";
import "./plugins-catalog.css";

/** Which mark each entry uses; an entry without one shows its initial. */
const MARK: Record<string, string> = {"Gmail": "gmail", "Google Drive": "googledrive", "Google Calendar": "googlecalendar", "GitHub": "github", "Slack": "slack", "Outlook Email": "microsoftoutlook", "Lyft": "lyft", "iCloud Mail": "icloud", "iCloud Calendar": "icloud", "Sonos": "sonos", "Dropbox": "dropbox", "Intuit QuickBooks": "quickbooks", "HubSpot": "hubspot", "Stripe": "stripe", "Canva": "canva"};

/**
 * The Plugins page in the browser, where plugins are not connected yet. It shows the catalog's layout only:
 * nothing here opens, installs or signs in, and every action reads "Unavailable". Marks identify each service only.
 */
const SECTIONS: { title: string; items: [name: string, line: string, tint: string][] }[] = [
  { title: "Popular", items: [
    ["Gmail", "Read and manage Gmail", "#EA4335"], ["Google Drive", "Drive, Docs, Sheets or Slides", "#4285F4"],
    ["Google Calendar", "Manage Google Calendar events", "#4285F4"], ["GitHub", "Triage PRs, issues, CI, and publish flows", "#181717"],
    ["Slack", "Read and manage Slack", "#4A154B"], ["Outlook Email", "Triage Outlook inboxes", "#0078D4"] ] },
  { title: "New & Noteworthy", items: [
    ["Lyft", "Request a Lyft ride.", "#FF00BF"], ["iCloud Mail", "Read and manage iCloud email", "#3693F3"],
    ["iCloud Calendar", "Read and manage iCloud events", "#3693F3"], ["ElevenLabs", "Voice agents and media", "#4b5563"],
    ["Tripsy", "Plan and organize your trips", "#d9822b"], ["Sonos", "Control your Sonos system", "#000000"] ] },
  { title: "Small Business", items: [
    ["Dropbox", "Find, create, and take action", "#0061FF"], ["Intuit QuickBooks", "Accounting Payments & Payroll", "#2CA01C"],
    ["HubSpot", "Insights to action in HubSpot", "#FF7A59"], ["Stripe", "Accept payments, grow revenue.", "#635BFF"],
    ["Canva", "Create, review, edit designs", "#00C4CC"], ["Gusto", "People and payroll, made easy", "#c9503f"] ] },
];

/** Example rows for the Skills layout. */
const SKILLS: [name: string, line: string][] = [
  ["deep research", "Multi-round gather → verify → synthesize, with sources"],
  ["skill-creator", "Guide for creating and updating high-quality skills"],
];

export function PluginsCatalog() {
  const [tab, setTab] = useState<"public" | "personal">("public");
  const [query, setQuery] = useState("");
  const [listOpen, setListOpen] = useState(true);
  const [section, setSection] = useState<"plugins" | "skills">("plugins");
  const [skillQuery, setSkillQuery] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const skills = SKILLS.filter(([name, line]) => `${name} ${line}`.toLowerCase().includes(skillQuery.trim().toLowerCase()));
  const match = (name: string, line: string) => `${name} ${line}`.toLowerCase().includes(query.trim().toLowerCase());
  const sections = SECTIONS.map((s) => ({ ...s, items: s.items.filter(([name, line]) => match(name, line)) })).filter((s) => s.items.length);
  return (
    <section className={`plugins-catalog${listOpen ? "" : " list-closed"}`} data-testid="plugins-catalog" aria-label="Plugins">
      {listOpen && <aside className="pc-list" aria-label="Customize">
        <header><h1>Customize</h1><button type="button" className="pc-icon" aria-label="Hide list" onClick={() => setListOpen(false)}><Icon name="sidebar" size={16} /></button></header>
        <button type="button" className="pc-nav" aria-current={section === "plugins" ? "page" : undefined} onClick={() => setSection("plugins")}><Icon name="shapes" size={16} />Plugins</button>
        <button type="button" className="pc-nav" data-testid="plugins-skills" aria-current={section === "skills" ? "page" : undefined} onClick={() => setSection("skills")}><Icon name="stack" size={16} />Skills</button>
        <h2>Installed</h2>
        <p className="pc-none">Nothing is installed here yet.</p>
      </aside>}
      {section === "skills" && <div className="pc-main">
        <div className="pc-page" data-testid="skills-page">
          <div className="pc-head">
            {!listOpen && <button type="button" className="pc-icon" aria-label="Show list" onClick={() => setListOpen(true)}><Icon name="sidebar" size={16} /></button>}
            <h2>Installed</h2>
            <label className="pc-search"><Icon name="search" size={15} /><input type="search" aria-label="Search skills" placeholder="Search skills" value={skillQuery} onChange={(e) => setSkillQuery(e.target.value)} /></label>
            <span className="composer-menu">
              <button ref={addRef} type="button" className="pc-add" data-testid="skills-add" aria-haspopup="menu" aria-expanded={menu === "add"} onClick={() => setMenu(menu === "add" ? null : "add")}>Add<Icon name="chevron-down" size={12} /></button>
              <Menu open={menu === "add"} onClose={() => setMenu(null)} anchorRef={addRef} label="Add a skill" placement="bottom-end">
                <MenuItem disabled><Icon name="compose" />Create with chat<small className="pc-soon">Unavailable</small></MenuItem>
                <MenuItem disabled><Icon name="review" />Create with editor<small className="pc-soon">Unavailable</small></MenuItem>
                <MenuItem disabled><Icon name="file" />Upload from your computer<small className="pc-soon">Unavailable</small></MenuItem>
              </Menu>
            </span>
          </div>
          <nav className="pc-crumbs" aria-label="Skills path"><span>Skills</span><Icon name="chevron-right" size={11} /><strong>Installed</strong></nav>
          <p className="pc-note" role="note">Skills aren’t connected in the browser yet. These two rows are examples of the layout, not installed skills.</p>
          {skills.length ? <ul className="pc-skills">
            {skills.map(([name, line]) => <li key={name} data-testid="skill-card">
              <span className="pc-mark pc-skill-mark" aria-hidden="true"><Icon name="stack" size={16} /></span>
              <span className="pc-text"><strong>{name}</strong><span>{line}</span></span>
              <span className="composer-menu">
                <button ref={(el) => { rowRefs.current[name] = el; }} type="button" className="pc-plus" aria-label={`Actions for ${name}`} aria-haspopup="menu" aria-expanded={menu === name} onClick={() => setMenu(menu === name ? null : name)}><Icon name="more" size={18} /></button>
                {menu === name && <Menu open onClose={() => setMenu(null)} anchorRef={{ current: rowRefs.current[name] ?? null }} label={`Actions for ${name}`} placement="bottom-end">
                  <MenuItem disabled><Icon name="comment" />Chat</MenuItem>
                  <MenuItem disabled><Icon name="compose" />Edit</MenuItem>
                  <MenuItem disabled><Icon name="download" />Download</MenuItem>
                  <MenuSeparator />
                  <MenuItem disabled className="danger"><Icon name="minus" />Uninstall</MenuItem>
                  <MenuItem disabled className="danger"><Icon name="trash" />Delete</MenuItem>
                </Menu>}
              </span>
            </li>)}
          </ul> : <p className="pc-none">No skills match “{skillQuery}”.</p>}
        </div>
      </div>}
      {section === "plugins" && <div className="pc-main">
        <div className="pc-page">
          <div className="pc-head">
            {!listOpen && <button type="button" className="pc-icon" aria-label="Show list" onClick={() => setListOpen(true)}><Icon name="sidebar" size={16} /></button>}
            <h2>Plugins</h2>
            <label className="pc-search"><Icon name="search" size={15} /><input type="search" aria-label="Search plugins" placeholder="Search plugins" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
            <button type="button" className="pc-add" data-testid="plugins-add" disabled>Unavailable</button>
          </div>
          <p className="pc-sub">Connect plugins to let Modex work across your tools</p>
          <p className="pc-note" role="note" data-testid="plugins-unavailable">Plugins aren’t connected in the browser yet. This is a preview of the catalog: nothing here can be added.</p>
          <div className="pc-tabs" role="tablist" aria-label="Catalog">
            <button type="button" role="tab" aria-selected={tab === "public"} onClick={() => setTab("public")}>Public</button>
            <button type="button" role="tab" aria-selected={tab === "personal"} onClick={() => setTab("personal")}>Personal</button>
          </div>
          {tab === "personal" ? <p className="pc-none">No personal plugins.</p> : sections.length ? sections.map((section) => (
            <div key={section.title} className="pc-section">
              <h3>{section.title}<Icon name="chevron-right" size={12} /></h3>
              <ul>
                {section.items.map(([name, line, tint]) => (
                  <li key={name} data-testid="plugin-card">
                    <span className="pc-mark" aria-hidden="true" style={{ background: tint }}>{MARK[name] ? <svg viewBox="0 0 24 24" width="20" height="20"><path fill="#fff" d={PLUGIN_MARKS[MARK[name]!]} /></svg> : name[0]}</span>
                    <span className="pc-text"><strong>{name}</strong><span>{line}</span></span>
                    <button type="button" className="pc-plus" disabled aria-label={`Add ${name}: unavailable`} title="Unavailable"><Icon name="plus" size={18} /></button>
                  </li>
                ))}
              </ul>
            </div>
          )) : <p className="pc-none">No plugins match “{query}”.</p>}
        </div>
      </div>}
    </section>
  );
}
