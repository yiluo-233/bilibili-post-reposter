// ==UserScript==
// @name         BiliBili Post Reposter
// @namespace    bilibili-post-reposter
// @version      1.2.0
// @description  每12小时检查全部关注UP主近两个月的官方抽奖，自动空文字转发，保存进度和记录。
// @match        https://t.bilibili.com/
// @noframes
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.bilibili.com
// @connect      api.vc.bilibili.com
// ==/UserScript==

(() => {
  'use strict';

  // 设置：检查周期与请求间隔分别控制；间隔并不保证平台不会限流。
  const CONFIG = { interval: 12 * 3600_000, requestGap: 3000, repostGap: 60_000 };
  const API = 'https://api.bilibili.com';
  const LOTTERY = 'https://api.vc.bilibili.com/lottery_svr/v1/lottery_svr/lottery_notice';
  const PREFIX = 'bili-lottery-v1:';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const read = (key, fallback) => GM_getValue(PREFIX + key, fallback);
  const write = (key, value) => GM_setValue(PREFIX + key, value);
  const cookie = name =>
    document.cookie
      .split('; ')
      .find(x => x.startsWith(name + '='))
      ?.slice(name.length + 1) || '';
  const account = () => cookie('DedeUserID');
  const idOf = value => {
    if (typeof value !== 'string' && !Number.isSafeInteger(value)) return '';
    const text = String(value ?? '');
    return /^[1-9]\d*$/.test(text) ? text : '';
  };
  let busy = false;
  let lastRequest = 0;
  let view;

  // 屏蔽名单按登录账号单独保存，扫描过程中随时读取最新名单。
  const isBlocked = (uid, mid) => read(`blocked:${uid}`, []).includes(mid);

  function parseBlocklist(text) {
    const ids = text
      .trim()
      .split(/[\s,，;；]+/)
      .filter(Boolean);
    if (ids.some(id => !/^[1-9]\d*$/.test(id))) throw new Error('请只填数字UID，用换行、空格或逗号分隔');
    return [...new Set(ids)];
  }

  // JSON中的动态ID可能是19位数字：先保留原始数字文本，避免JavaScript精度丢失。
  function parseJSON(text) {
    return JSON.parse(
      text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token =>
        /^-?\d{16,}$/.test(token) ? JSON.stringify(token) : token
      )
    );
  }

  function twoMonthsAgo(now = new Date()) {
    const date = new Date(now);
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() - 2);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, lastDay));
    return Math.floor(date.getTime() / 1000);
  }

  function log(uid, message, id = '') {
    const rows = read(`logs:${uid}`, []);
    rows.push({ time: new Date().toLocaleString(), message, id });
    write(`logs:${uid}`, rows.slice(-200));
    console.info('[B站抽奖]', message, id ? `https://t.bilibili.com/${id}` : '');
    render();
  }

  function checkSession(uid) {
    if (account() !== uid || !cookie('bili_jct')) throw new Error('账号已切换或登录已失效');
    if (read(`paused:${uid}`, false)) throw new Error('已暂停');
  }

  // 所有请求串行执行。读取失败和写入失败均暂停；写入绝不自动重试。
  async function request(uid, endpoint, params = {}, body, beforeSend = () => true) {
    await sleep(Math.max(0, lastRequest + CONFIG.requestGap - Date.now()));
    checkSession(uid);
    if (beforeSend() === false) return null;
    const url = new URL(endpoint.startsWith('https:') ? endpoint : API + endpoint);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    if (body) url.searchParams.set('csrf', cookie('bili_jct'));
    lastRequest = Date.now();
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: body ? 'POST' : 'GET',
        url: url.href,
        timeout: 30_000,
        anonymous: false,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        data: body ? JSON.stringify(body) : undefined,
        onerror: () => reject(new Error('网络请求失败（可能被浏览器拦截）')),
        ontimeout: () => reject(new Error('请求超时；转发请求不会自动重试')),
        onabort: () => reject(new Error('请求被中断')),
        onload: response => {
          try {
            if (response.status !== 200) throw new Error(`HTTP ${response.status}：${url.pathname}`);
            const result = parseJSON(response.responseText);
            if (result.code !== 0)
              throw new Error(
                `接口错误 ${result.code}：${url.pathname}；${String(result.message || result.msg || '').slice(0, 120)}`
              );
            if (!result.data || typeof result.data !== 'object') throw new Error(`接口数据缺失：${url.pathname}`);
            resolve(result.data);
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  }

  // 关注列表必须完整读完；分页异常不能当作“扫描完成”。
  async function getFollowings(uid) {
    const users = new Map();
    for (let page = 1; ; page++) {
      const data = await request(uid, '/x/relation/followings', {
        vmid: uid,
        pn: page,
        ps: 50,
        order: 'desc'
      });
      if (!Array.isArray(data.list) || !Number.isSafeInteger(data.total) || data.total < 0)
        throw new Error('关注列表格式变化');
      const before = users.size;
      for (const user of data.list) {
        const mid = idOf(user.mid);
        if (!mid) throw new Error('关注列表UID无效');
        users.set(mid, { mid, name: String(user.uname || mid) });
      }
      if (users.size >= data.total) return [...users.values()];
      if (users.size === before) throw new Error('关注列表分页提前结束，请稍后继续');
    }
  }

  // 只查当前动态自身的官方抽奖节点，不把UP主转发的其他人的抽奖算成自办抽奖。
  function hasLottery(item) {
    if (item.type === 'DYNAMIC_TYPE_FORWARD') return false;
    const stack = [item.modules?.module_dynamic];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'RICH_TEXT_NODE_TYPE_LOTTERY') return true;
      stack.push(...Object.values(node).filter(value => value && typeof value === 'object'));
    }
    return false;
  }

  // 未知状态、额外参与条件和字段缺失都不猜测；将原因写入日志。
  function skipReason(info, mid, now = Date.now()) {
    if (!idOf(info.lottery_id) || Number(info.business_type) !== 1) return '抽奖类型无法确认';
    if (idOf(info.sender_uid) !== mid) return '抽奖发起人与UP主不一致';
    if (info.participated === true || info.reposted === true) return '已参与';
    if (Number(info.status) === 2) return '已开奖';
    const deadline = Number(info.lottery_time) * 1000;
    if (!Number.isFinite(deadline) || deadline <= 0) return '截止时间缺失';
    if (deadline <= now + 5000) return '已截止或即将截止';
    if (info.status !== 0) return '抽奖状态无法确认';
    if (info.participated !== false || info.reposted !== false) return '参与状态字段缺失';
    if (info.followed !== true) return '当前未关注或关注状态无法确认';
    if (info.lottery_at_num !== 0) return '要求@好友或条件字段缺失';
    if (info.upower_redirect_url || info.vip_redirect_url) return '充电/会员抽奖，请手动查看';
    return '';
  }

  async function lotteryInfo(uid, id) {
    return request(uid, LOTTERY, {
      business_id: id,
      business_type: 1,
      web_location: '333.1330',
      'x-bili-device-req-json': JSON.stringify({ platform: 'web', device: 'pc', spmid: '333.1330' })
    });
  }

  async function participate(ctx, item, user) {
    const { uid, state } = ctx;
    const remember = (id, status, repostId) => {
      state.records[id] = { status, time: Date.now(), ...(repostId ? { repostId } : {}) };
      ctx.save();
    };
    if (isBlocked(uid, user.mid)) return;
    const id = idOf(item.id_str);
    if (!id) throw new Error('动态ID缺失或精度不安全');
    if (state.records[id]?.status === 'done') return;
    const info = await lotteryInfo(uid, id);
    if (info.participated === true || info.reposted === true) {
      remember(id, 'done');
      return;
    }
    // 上次发出请求但未拿到明确结果：保留记录，继续扫描时也不会重发它。
    if (state.records[id]?.status === 'pending') {
      log(uid, '结果不明，已跳过；请在个人动态中核对', id);
      return;
    }
    const reason = skipReason(info, user.mid);
    if (reason) {
      log(uid, `跳过：${reason}`, id);
      return;
    }
    if (item.modules?.module_stat?.forward?.forbidden) {
      log(uid, '跳过：禁止转发', id);
      return;
    }

    await sleep(Math.max(0, (state.lastPost || 0) + CONFIG.repostGap - Date.now()));
    if (isBlocked(uid, user.mid)) return;
    // 等待后再次确认状态和关注关系，避免排队期间开奖或取消关注。
    const relation = await request(uid, '/x/relation', { fid: user.mid });
    if (![2, 6].includes(relation.attribute)) {
      log(uid, '跳过：已取消关注', id);
      return;
    }
    const fresh = await lotteryInfo(uid, id);
    const result = await request(
      uid,
      '/x/dynamic/feed/create/dyn',
      { platform: 'web' },
      {
        dyn_req: {
          content: { contents: [] },
          scene: 4,
          upload_id: `${uid}_${Math.floor(Date.now() / 1000)}_${crypto.getRandomValues(new Uint32Array(1))[0] % 10000}`,
          meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
          option: { aigc: 2 }
        },
        web_repost_src: { dyn_id_str: id }
      },
      () => {
        // 节流等待结束、真正发出POST之前，再检查屏蔽与截止时间。
        if (isBlocked(uid, user.mid)) return false;
        const reason = skipReason(fresh, user.mid);
        if (reason) {
          log(uid, `跳过：${reason}`, id);
          return false;
        }
        state.lastPost = Date.now();
        remember(id, 'pending');
        return true;
      }
    );
    if (!result) return;
    const repostId = idOf(result.dyn_id_str) || idOf(result.dyn_id);
    if (!repostId || (result.result !== undefined && result.result !== 0))
      throw new Error(`转发结果未确认，请检查个人动态：${id}`);
    state.job.sent++;
    remember(id, 'done', repostId);
    log(uid, `转发成功：${user.name}（仅确认转发成功，抽奖资格以B站为准）`, repostId);
  }

  async function scanUser(ctx, user) {
    const { uid, state } = ctx;
    const job = state.job;
    const seenOffsets = new Set();
    for (;;) {
      checkSession(uid);
      if (isBlocked(uid, user.mid)) return;
      if (seenOffsets.has(job.offset)) throw new Error('动态分页重复，已停止');
      seenOffsets.add(job.offset);
      const data = await request(
        uid,
        '/x/polymer/web-dynamic/v1/feed/space',
        {
          host_mid: user.mid,
          offset: job.offset,
          timezone_offset: -480,
          features: 'itemOpusStyle'
        },
        undefined,
        () => !isBlocked(uid, user.mid)
      );
      if (!data || isBlocked(uid, user.mid)) return;
      if (!Array.isArray(data.items) || ![true, false, 0, 1].includes(data.has_more))
        throw new Error('动态列表格式变化');
      const normalTimes = [];
      for (const item of data.items) {
        if (isBlocked(uid, user.mid)) return;
        const author = item.modules?.module_author;
        const timestamp = Number(author?.pub_ts);
        if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error('动态发布时间缺失，无法确认回溯范围');
        if (!item.modules?.module_tag?.text?.includes('置顶')) normalTimes.push(timestamp);
        if (timestamp < job.cutoff || idOf(author.mid) !== user.mid || !hasLottery(item)) continue;
        job.found++;
        await participate(ctx, item, user);
      }
      // 置顶动态不影响截止判断；只有整页非置顶动态都过旧才停止翻页。
      const pastCutoff = normalTimes.length > 0 && normalTimes.every(time => time < job.cutoff);
      if (!data.has_more || pastCutoff) return;
      if (!data.items.length || !data.offset || data.offset === job.offset)
        throw new Error('动态分页提前结束或游标未前进');
      job.offset = String(data.offset);
      ctx.save();
    }
  }

  async function run(uid, force = false) {
    const state = read(`state:${uid}`, { records: {}, nextRun: 0, job: null });
    const ctx = { uid, state, save: () => write(`state:${uid}`, state) };
    if (!force && (read(`paused:${uid}`, false) || (!state.job && Date.now() < state.nextRun))) return;
    if (force) write(`paused:${uid}`, false);
    try {
      checkSession(uid);
      const nav = await request(uid, '/x/web-interface/nav');
      if (nav.isLogin !== true || idOf(nav.mid) !== uid) throw new Error('登录身份验证失败');
      if (!state.job) {
        log(uid, '正在读取全部关注列表');
        const users = await getFollowings(uid);
        state.job = { users, index: 0, offset: '', cutoff: twoMonthsAgo(), found: 0, sent: 0 };
        ctx.save();
        log(uid, `开始扫描 ${users.length} 位UP主，回溯两个月`);
      }
      const job = state.job;
      while (job.index < job.users.length) {
        const user = job.users[job.index];
        checkSession(uid);
        log(
          uid,
          `${isBlocked(uid, user.mid) ? '屏蔽，跳过' : '扫描'} ${job.index + 1}/${job.users.length}：${user.name}`
        );
        await scanUser(ctx, user);
        job.index++;
        job.offset = '';
        ctx.save();
      }
      log(uid, `本轮完成：检查抽奖 ${job.found} 次，成功转发 ${job.sent} 条；12小时后再检查`);
      state.job = null;
      state.nextRun = Date.now() + CONFIG.interval;
      ctx.save();
    } catch (error) {
      write(`paused:${uid}`, true);
      log(uid, `已暂停：${error.message}`);
    }
  }

  // 同一域名的多个标签页共用浏览器锁，防止同时扫描和转发。
  async function tick(force = false) {
    if (busy || !account()) return;
    if (!navigator.locks) {
      view.status.textContent = '浏览器不支持Web Locks，无法运行';
      return;
    }
    busy = true;
    try {
      await navigator.locks.request(PREFIX + 'worker', { ifAvailable: true }, async lock => {
        if (lock) await run(account(), force);
        else if (force) log(account(), '另一个标签页正在扫描，无需重复启动');
      });
    } catch (error) {
      view.status.textContent = `调度失败：${error.message}`;
    } finally {
      busy = false;
      render();
    }
  }

  function pause() {
    const uid = account();
    if (!uid) return;
    write(`paused:${uid}`, true);
    log(uid, '已请求暂停；已发出的请求可能仍会完成');
  }

  function resume() {
    const uid = account();
    if (!uid) return;
    write(`paused:${uid}`, false);
    log(uid, '已恢复自动扫描；结果不明的转发仍会跳过');
    void tick();
  }

  function editBlocklist() {
    const uid = account();
    if (!uid) return;
    view.editor.hidden = !view.editor.hidden;
    if (view.editor.hidden) return;
    view.editingUid = uid;
    view.blocklist.value = read(`blocked:${uid}`, []).join('\n');
    view.message.textContent = '';
  }

  function saveBlocklist() {
    if (account() !== view.editingUid) {
      view.message.textContent = '账号已切换，请重新打开名单';
      return;
    }
    try {
      const ids = parseBlocklist(view.blocklist.value);
      write(`blocked:${view.editingUid}`, ids);
      view.blocklist.value = ids.join('\n');
      view.message.textContent = `已保存 ${ids.length} 个UID`;
      log(view.editingUid, `屏蔽名单已更新：${ids.length} 位UP主`);
    } catch (error) {
      view.message.textContent = error.message;
    }
  }

  function blockCurrent() {
    const uid = account();
    const user = view.currentUser;
    if (!user || view.currentUid !== uid) return;
    const ids = [...new Set([...read(`blocked:${uid}`, []), user.mid])];
    write(`blocked:${uid}`, ids);
    if (!view.editor.hidden && view.editingUid === uid) {
      // 保留正在编辑但尚未保存的内容，同时补上本次屏蔽项。
      view.blocklist.value += `\n${user.mid}`;
      view.message.textContent = '当前UP已屏蔽；其他编辑仍需点击保存';
    }
    log(uid, `已屏蔽 ${user.name}（UID ${user.mid}）；已发出的请求无法撤回`);
  }

  // 面板只用textContent写入平台文本，不执行动态中的HTML。
  function render() {
    if (!view) return;
    const uid = account();
    if (!uid) {
      view.status.textContent = '请先登录B站';
      return;
    }
    const state = read(`state:${uid}`, {});
    const paused = read(`paused:${uid}`, false);
    const user = state.job?.users[state.job.index];
    view.currentUser = user;
    view.currentUid = uid;
    view.resume.disabled = !paused;
    view.start.disabled = busy;
    view.block.disabled = !user || isBlocked(uid, user.mid);
    const progress = state.job ? `进度 ${state.job.index}/${state.job.users.length}，已转发 ${state.job.sent}` : '';
    const next = state.nextRun ? new Date(state.nextRun).toLocaleString() : '即将开始';
    const current = user ? `\n当前：${user.name}（UID ${user.mid}）` : '';
    view.status.textContent = `UID ${uid}\n${paused ? '已暂停 ' + progress : progress || `下次检查：${next}`}${current}\n已屏蔽 ${read(`blocked:${uid}`, []).length} 位UP主`;
    view.logs.replaceChildren();
    for (const row of read(`logs:${uid}`, []).slice(-15)) {
      const line = document.createElement('div');
      line.textContent = `${row.time} ${row.message} `;
      if (idOf(row.id)) {
        const link = document.createElement('a');
        link.href = `https://t.bilibili.com/${row.id}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = '查看动态';
        line.append(link);
      }
      view.logs.append(line);
    }
  }

  function exportLogs() {
    const uid = account();
    const state = read(`state:${uid}`, {});
    const data = {
      version: '1.2.0',
      uid,
      blocked: read(`blocked:${uid}`, []),
      nextRun: state.nextRun,
      job: state.job,
      records: state.records,
      logs: read(`logs:${uid}`, [])
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `bili-lottery-${uid || 'guest'}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // 面板使用页面坐标，随页面滚动；低层级让聊天侧边栏等浮层覆盖它。
  function mount() {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;right:180px;top:240px;z-index:1';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        details {
          width: 310px;
          color-scheme: dark;
          background: #1e1e24;
          color: #e6e6eb;
          border: 1px solid #3a3a45;
          border-radius: 10px;
          box-shadow: 0 3px 16px #0006;
          font: 13px/1.6 sans-serif;
        }
        summary { cursor: pointer; padding: 9px 12px; font-weight: bold; }
        section { padding: 0 12px 12px; }
        p { white-space: pre-line; margin: 4px 0 8px; }
        button, textarea { background: #2b2b34; color: #e6e6eb; border: 1px solid #50505e; border-radius: 5px; }
        button { cursor: pointer; margin: 0 6px 8px 0; padding: 4px 8px; }
        button:hover:not(:disabled) { background: #3a3a46; }
        button:disabled { cursor: default; opacity: 0.5; }
        textarea { box-sizing: border-box; width: 100%; min-height: 90px; resize: vertical; }
        textarea::placeholder, small { color: #aaaab8; }
        small { display: block; margin-bottom: 8px; }
        #logs { max-height: 260px; overflow: auto; font-size: 12px; }
        #logs div { border-top: 1px solid #383842; padding: 6px 0; }
        #editor { margin-bottom: 8px; }
        a, #message { color: #78c9ff; }
      </style>
      <details>
        <summary>B站抽奖助手</summary>
        <section>
          <p id="status"></p>
          <button id="start" title="不等12小时；有未完成任务时接着扫描">立即检查</button>
          <button id="resume" title="解除暂停，按原有进度和时间安排执行">恢复扫描</button>
          <button id="pause">暂停</button>
          <small>立即检查：现在执行。恢复扫描：解除暂停。</small>
          <button id="block">屏蔽当前UP</button>
          <button id="manage">屏蔽名单</button>
          <button id="export">导出日志</button>
          <div id="editor" hidden>
            <label for="blocklist">不扫描的UP主UID（每行一个）</label>
            <textarea id="blocklist" placeholder="123456\n789012"></textarea>
            <small>UID是UP主空间网址中的数字。也支持空格、逗号分隔；删除UID并保存即可解除屏蔽。</small>
            <button id="save">保存名单</button>
            <p id="message"></p>
          </div>
          <div id="logs"></div>
        </section>
      </details>
    `;
    document.body.append(host);
    view = Object.fromEntries([...root.querySelectorAll('[id]')].map(el => [el.id, el]));
    const actions = {
      start: () => void tick(true),
      resume,
      pause,
      block: blockCurrent,
      manage: editBlocklist,
      save: saveBlocklist,
      export: exportLogs
    };
    for (const [id, action] of Object.entries(actions)) view[id].onclick = action;
    for (const id of ['start', 'resume', 'manage', 'pause', 'export']) {
      GM_registerMenuCommand(view[id].textContent, actions[id]);
    }
    render();
  }

  mount();
  const refresh = () => {
    render();
    void tick();
  };
  setInterval(refresh, 30_000);
  window.addEventListener('focus', refresh);
  void tick();
})();
