/** Adopt only browser-proven opener descendants of an already owned task tab. */
export function adoptScopedPopups(spaces, targets) {
  const owners = new Map();
  const byId = new Map(targets.map(target => [target.targetId, target]));
  for (const space of spaces) for (const id of space.targetIds || []) {
    owners.set(id, owners.has(id) ? null : space);
  }
  let changed = false;
  for (const space of spaces) {
    if (space.browserContextId) continue;
    const contexts = new Set((space.targetIds || []).map(id => byId.get(id)).filter(Boolean).map(target => target.browserContextId || null));
    if (contexts.size === 1 && !contexts.has(null)) {
      const context = [...contexts][0];
      if (space.scopedContextId !== context) { space.scopedContextId = context; changed = true; }
    }
  }
  for (let iteration = 0; iteration < Math.min(targets.length, 256); iteration++) {
    let adopted = false;
    for (const target of targets.slice(0, 256)) {
      if (target.type !== 'page' || !target.openerId || owners.has(target.targetId)) continue;
      const owner = owners.get(target.openerId);
      if (!owner) continue;
      const parent = byId.get(target.openerId);
      // Chrome reports an opaque context ID even for its default cookie jar.
      const context = owner.browserContextId || parent?.browserContextId || owner.scopedContextId || null;
      if ((target.browserContextId || null) !== context || (parent && (parent.browserContextId || null) !== context)) continue;
      owner.targetIds.push(target.targetId);
      owners.set(target.targetId, owner);
      adopted = changed = true;
    }
    if (!adopted) break;
  }
  return changed;
}
