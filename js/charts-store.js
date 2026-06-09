/**
 * 命盘存储 — MySQL API
 * 所有数据通过后端 API 存取
 */

const ChartsStore = (() => {
  'use strict';

  function token() {
    return AUTH.getToken();
  }

  function headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token(),
    };
  }

  /** 获取所有命盘 */
  async function getAll() {
    const res = await fetch('/api/charts', { headers: headers() });
    if (!res.ok) {
      throw { status: res.status, message: res.status === 401 ? '登录已过期，请重新登录' : '获取命盘失败' };
    }
    return await res.json();
  }

  /** 根据 id 获取 */
  async function get(id) {
    const res = await fetch('/api/charts/' + id, { headers: headers() });
    if (!res.ok) return null;
    return await res.json();
  }

  /** 添加命盘 */
  async function add(data) {
    const res = await fetch('/api/charts', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('保存失败');
    return await res.json();
  }

  /** 更新命盘 */
  async function update(id, data) {
    const res = await fetch('/api/charts/' + id, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || '更新失败');
    }
    return await res.json();
  }

  /** 删除命盘 */
  async function remove(id) {
    const res = await fetch('/api/charts/' + id, {
      method: 'DELETE',
      headers: headers(),
    });
    if (!res.ok) throw new Error('删除失败');
  }

  return { getAll, get, add, update, remove };
})();

window.ChartsStore = ChartsStore;
