export async function appClientMain(runtime) {
  const { layout, threshold, projectKey } = runtime;
  const timers = new Map();
  const knownCustomIds = new Set();
  const normalize = value => String(value || '').trim().toUpperCase();
  const escapeRegex = value => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cardPattern = new RegExp(`^CUSTOM_JIRA_CARD:(${escapeRegex(projectKey)}-\\d+)$`, 'i');

  const imageKey = item => {
    const title = String(item && ((item.data && item.data.title) || item.title) || '').trim();
    const match = title.match(cardPattern);
    return match ? normalize(match[1]) : null;
  };

  const snapshot = item => {
    if (!item || item.type !== 'image') return null;
    const key = imageKey(item);
    return key ? { item, key, x: Number(item.x), y: Number(item.y), width: Number(item.width) || 1 } : null;
  };

  const inside = (x, y) => Number.isFinite(x) && Number.isFinite(y)
    && x >= layout.board.left && x <= layout.board.right
    && y >= layout.board.top && y <= layout.board.bottom;

  async function canvasPosition(item, seen = new Set()) {
    if (!item) return null;
    const id = String(item.id || '');
    if (id && seen.has(id)) return null;
    if (id) seen.add(id);
    const x = Number(item.x), y = Number(item.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const parentId = String(item.parentId || '').trim();
    const relative = String(item.relativeTo || 'canvas_center');
    if (!parentId || relative === 'canvas_center') return { x, y };
    const parent = await miro.board.getById(parentId);
    if (!parent) return null;
    const parentPosition = await canvasPosition(parent, seen);
    if (!parentPosition) return null;
    if (relative === 'parent_center') return { x: parentPosition.x + x, y: parentPosition.y + y };
    if (relative === 'parent_top_left') {
      const width = Number(parent.width), height = Number(parent.height);
      return Number.isFinite(width) && Number.isFinite(height)
        ? { x: parentPosition.x - width / 2 + x, y: parentPosition.y - height / 2 + y }
        : null;
    }
    return null;
  }

  async function boardPosition(s) {
    const item = s.item, x = s.x, y = s.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const parentId = String(item && item.parentId || '').trim();
    const relative = String(item && item.relativeTo || 'canvas_center');
    if (parentId && relative.startsWith('parent_')) {
      const parent = await miro.board.getById(parentId);
      const width = Number(parent && parent.width), height = Number(parent && parent.height);
      if (parent && Number.isFinite(width) && Number.isFinite(height)
          && width >= layout.board.right && height >= layout.board.bottom && inside(x, y)) return { x, y };
    }
    const canvas = await canvasPosition(item);
    if (!canvas) return null;
    if (inside(canvas.x, canvas.y)) return canvas;
    const frames = await miro.board.get({ type: 'frame' });
    const candidates = (frames || []).map(frame => {
      const fx = Number(frame.x), fy = Number(frame.y), width = Number(frame.width), height = Number(frame.height);
      if (![fx, fy, width, height].every(Number.isFinite) || width < layout.board.right || height < layout.board.bottom) return null;
      const left = fx - width / 2, top = fy - height / 2;
      const localX = canvas.x - left, localY = canvas.y - top;
      return inside(localX, localY) ? { x: localX, y: localY, area: width * height } : null;
    }).filter(Boolean).sort((a, b) => a.area - b.area);
    return candidates[0] || null;
  }

  async function column(s) {
    const position = await boardPosition(s);
    if (!position) return null;
    const width = s.width || 1, left = position.x - width / 2, right = position.x + width / 2;
    return layout.columns.map(candidate => ({
      ...candidate,
      ratio: Math.max(0, Math.min(right, candidate.right) - Math.max(left, candidate.left)) / width,
    })).sort((a, b) => b.ratio - a.ratio)[0] || null;
  }

  async function post(path, body) {
    const token = await miro.board.getIdToken();
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  async function register() {
    const info = await miro.board.getInfo();
    const cards = [];
    for (const item of await miro.board.get({ type: 'image' }) || []) {
      const card = snapshot(item);
      if (!card) continue;
      knownCustomIds.add(String(item.id));
      cards.push({ issueKey: card.key, itemId: String(item.id) });
    }
    if (cards.length) await post('/register-custom-cards', { boardId: info.id, cards });
  }

  function schedule(itemId, delay = 1200) {
    const id = String(itemId);
    const existing = timers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(id);
      evaluate(id).catch(console.error);
    }, delay);
    timers.set(id, timer);
  }

  async function evaluate(id) {
    const first = snapshot(await miro.board.getById(id));
    if (!first) return;
    knownCustomIds.add(id);
    await new Promise(resolve => setTimeout(resolve, 300));
    const second = snapshot(await miro.board.getById(id));
    if (!second) return;
    if (Math.abs(second.x - first.x) > 1 || Math.abs(second.y - first.y) > 1) {
      schedule(id, 350);
      return;
    }
    const target = await column(second);
    if (!target || target.ratio < threshold) return;
    const info = await miro.board.getInfo();
    let response, result;
    try {
      response = await post('/custom-miro-to-jira', {
        boardId: info.id,
        issueKey: second.key,
        itemId: id,
        desiredStatus: target.status,
      });
      result = await response.json();
    } catch (error) {
      console.error('Status sync failed', error);
      try { await miro.board.notifications.showError(`${second.key} could not be synchronized with Jira.`); } catch {}
      return;
    }
    if (!response.ok || result && result.ok === false) {
      const message = result && result.reason === 'TEST_AREA_REQUIRED'
        ? 'Test area must be filled in before moving to Functional review.'
        : `${second.key} could not be moved to ${target.status}. Jira kept its current status and the card was reconciled back.`;
      try { await miro.board.notifications.showError(message); } catch {}
    }
  }

  function itemsUpdated(event) {
    for (const item of event && event.items || []) {
      const id = String(item && item.id || '').trim();
      if (!id) continue;
      if (item.type === 'image' || knownCustomIds.has(id)) schedule(id);
      else if (item.parentId && knownCustomIds.has(String(item.parentId))) schedule(String(item.parentId));
    }
  }

  await miro.board.ui.on('icon:click', async () => {
    try {
      await register();
      if (await miro.board.ui.canOpenPanel()) await miro.board.ui.openPanel({ url: '/miro-panel' });
    } catch (error) {
      console.error(error);
    }
  });

  await miro.board.ui.on('experimental:items:update', itemsUpdated);
  await register();
  console.log('Jira/Miro SVG custom-card sync app ready');
}
