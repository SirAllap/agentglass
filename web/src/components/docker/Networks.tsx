/*
 * Networks: one sentence, three cards that also filter, then a small map per
 * network: its driver, subnet and the containers on it with their ports. A
 * container on several networks appears on each, and says what else it is on.
 * bridge, host and none are Docker's own: shown, never offered for removal.
 */
import { useMemo, useState } from "react";
import type { DockerContainer, DockerNetwork } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { networksView, networkMemberCounts, type NetworkKind } from "../../lib/dockerResources.ts";
import {
  networkAnswers, networkHit, networkLinks, networkMenu, networkRemovable, networkShape, sectionsOf, type NetworkItem, type NetworkLink,
} from "../../lib/dockerResourceUi.ts";
import { LockIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { NodesIcon } from "./DockerIcons.tsx";
import {
  Answers, Badge, ConfirmBar, ContainerChip, copyTo, GroupHead, MoreButton, NoMatch, ReadOnlyNote, RemoveButton,
  ResourceEmpty, Sentence, Shape, useMenu, XMenu,
} from "./ResourceKit.tsx";

const SECTIONS = [{ key: "use", title: "Yours, in use" }, { key: "none", title: "Yours, nothing attached" }, { key: "built", title: "Built in" }] as const;
const SHOWN = 6;

/** Host ports a container publishes, once each. */
const hostPorts = (c: DockerContainer) => [...new Map((c.portList ?? []).map((p) => [p.host, p])).values()];

export function Networks({ networks, containers, q, readOnly, flash, onClear, onGoContainer }: {
  networks: DockerNetwork[]; containers: DockerContainer[]; q: string; readOnly: boolean;
  flash: (ok: boolean, msg: string) => void; onClear: () => void; onGoContainer: (id: string) => void;
}) {
  const view = useMemo(() => networksView(networks, networkMemberCounts(networks)), [networks]);
  const links = useMemo(() => networkLinks(networks), [networks]);
  const byId = useMemo(() => new Map(containers.map((c) => [c.id, c])), [containers]);
  const [only, setOnly] = useState<NetworkKind | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const menu = useMenu();

  if (!networks.length) return <ResourceEmpty icon={<NodesIcon size={ICON.xl} />} title="No networks" text="Docker always has bridge, host and none, so this means it could not be read." />;

  const sections = sectionsOf(view.groups, SECTIONS, only, (i) => networkHit(i, q));
  const remove = async (i: NetworkItem) => {
    setArmed(null); setBusy(i.network.name);
    try { const r = await api.dockerRemoveNetwork(i.network.name); flash(r.ok, r.ok ? `Removed ${i.network.name}` : (r.error || "Docker refused")); }
    catch (e) { flash(false, String(e)); }
    finally { setBusy(null); }
  };
  const menuItem = menu.key ? view.items.find((i) => i.network.name === menu.key) : undefined;

  return (
    <div className="dk-xs">
      <Sentence lead={view.lead} rest={view.rest} />
      <Answers cards={networkAnswers(view, links)} active={only} onPick={(k: NetworkKind) => setOnly((cur) => (cur === k ? null : k))} what="network" />
      {sections.length === 0 ? <NoMatch q={q} filtered={only !== null} onClear={() => { setOnly(null); onClear(); }} />
        : sections.map((s) => (
          <div key={s.key}>
            <GroupHead title={s.title} sub={String(s.items.length)} />
            <div className="dk-xgrid" data-net>
              {s.items.map((i) => (
                <NetworkCard key={i.network.name} i={i} members={links[i.network.name] ?? []} byId={byId} readOnly={readOnly}
                  open={!!expanded[i.network.name]} onToggle={() => setExpanded((e) => ({ ...e, [i.network.name]: !e[i.network.name] }))}
                  armed={armed === i.network.name} pending={busy === i.network.name} menuOpen={menu.key === i.network.name}
                  onMenu={menu.open(i.network.name)} onArm={() => setArmed(i.network.name)} onNo={() => setArmed(null)} onYes={() => void remove(i)}
                  onGoContainer={onGoContainer} />
              ))}
            </div>
          </div>
        ))}
      <ReadOnlyNote on={readOnly} />
      {menuItem && (
        <XMenu anchor={menu.anchor} entries={networkMenu(menuItem, readOnly)} onClose={menu.close}
          onPick={(v) => {
            if (v === "copy") void copyTo(menuItem.network.name, "the network name", flash);
            else if (v === "rm") setArmed(menuItem.network.name);
          }} />
      )}
    </div>
  );
}

function NetworkCard({ i, members, byId, readOnly, open, onToggle, armed, pending, menuOpen, onMenu, onArm, onNo, onYes, onGoContainer }: {
  i: NetworkItem; members: NetworkLink[]; byId: Map<string, DockerContainer>; readOnly: boolean; open: boolean; onToggle: () => void;
  armed: boolean; pending: boolean; menuOpen: boolean; onMenu: (el: HTMLElement) => void; onArm: () => void; onNo: () => void; onYes: () => void;
  onGoContainer: (id: string) => void;
}) {
  const { network: n } = i;
  const worn = networkShape(i);
  const rm = networkRemovable(i);
  const shown = open ? members : members.slice(0, SHOWN);
  const where = i.kind === "built" ? (n.name === "bridge" ? "where a container lands when you name no network" : "always there")
    : !n.members ? "could not read what is attached"
    : members.length ? `${members.length} container${members.length === 1 ? "" : "s"}` : "nothing attached";
  return (
    <div className="dk-xk" data-dim={i.kind === "none" || undefined} role="group" aria-label={`${n.name}, ${worn.word}`}>
      <div className="dk-xt">
        <Shape worn={worn} />
        <div className="nm">
          <b className="dk-xn" title={n.name}>{n.name}</b>
          <span className="dk-drv" data-d={n.driver}>{n.driver}</span>
          {i.kind === "built" && <Badge tone="var(--info)" title="Docker creates this network itself"><LockIcon size={ICON.xs} />built in</Badge>}
        </div>
        <RemoveButton label={`Remove ${n.name}`} off={!rm.ok} reason={rm.why} readOnly={readOnly} pending={pending} lock={i.kind === "built"} onClick={onArm} />
        <MoreButton label={n.name} open={menuOpen} onMenu={onMenu} />
      </div>
      <div className="dk-xsub">{n.subnet ? `${n.subnet} · ` : ""}{n.scope} · {where}</div>
      {members.length > 0
        ? (
          <div className="dk-xmem">
            {shown.map((m) => {
              const c = byId.get(m.id);
              return (
                <div className="dk-xm" key={m.id}>
                  {c ? <ContainerChip c={c} onGo={onGoContainer} /> : <span className="dk-xe">{m.name}</span>}
                  <span className="ports">
                    {c && hostPorts(c).length
                      ? hostPorts(c).map((p) => (
                        <button type="button" key={p.host} className="dk-pchip" data-web={(p.web && c.state === "running") || undefined}
                          title={`host :${p.host} to container :${p.container}${c.state === "running" ? "" : " (published when it runs)"}. Open the container`}
                          onClick={() => onGoContainer(c.id)}>:{p.host}</button>))
                      : <span className="dk-xe">no published port</span>}
                  </span>
                  {m.also.length
                    ? <span className="dk-xa" title={`Also on ${m.also.join(", ")}`}><NodesIcon size={ICON.xs} />also on {m.also.length} other{m.also.length === 1 ? "" : "s"}</span>
                    : <span />}
                </div>
              );
            })}
            {members.length > SHOWN && (
              <button type="button" className="dk-xm" data-tog onClick={onToggle}>{open ? "Show fewer" : `+${members.length - SHOWN} more`}</button>
            )}
          </div>
        )
        : i.kind === "none" && n.members ? <div className="dk-xwhy" style={{ paddingTop: 8 }}>Nothing is attached, so it can go.</div> : null}
      {armed && (
        <ConfirmBar yes="remove" onYes={onYes} onNo={onNo}>remove the network <b>{n.name}</b>? Nothing is attached to it.</ConfirmBar>
      )}
    </div>
  );
}
