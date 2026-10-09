'use strict';

/**
 * 服务器自动配置：
 *   1. 识别系统
 *   2. 判断登录身份（root / 需要 sudo）
 *   3. 检查并开启 sshd 的 GatewayPorts、AllowTcpForwarding、保活
 *   4. 校验配置并重载 sshd
 *   5. 防火墙放行要用到的端口
 * 全程通过 SSH 执行，不需要人工登录服务器。
 */

const SUDO = { sudo: true };

async function provision(ssh, log, opts = {}) {
  const ports = (opts.ports || []).filter((p) => Number(p) > 0);
  const sudoPassword = opts.sudoPassword || '';
  const steps = [];
  const add = (key, title, status, detail) => {
    const s = { key, title, status, detail: detail || '' };
    steps.push(s);
    log[status === 'error' ? 'error' : status === 'warn' ? 'warn' : 'ok'](`${title}${detail ? ' — ' + detail : ''}`);
    return s;
  };

  // ---- 1. 识别系统 ----
  let os = '未知系统';
  try {
    const r = await ssh.exec('cat /etc/os-release 2>/dev/null || uname -a');
    const m = /PRETTY_NAME="([^"]+)"/.exec(r.stdout);
    os = m ? m[1] : (r.stdout.trim().split('\n')[0] || '未知系统');
    add('os', '识别服务器系统', 'ok', os);
  } catch (err) {
    add('os', '识别服务器系统', 'warn', err.message);
  }

  // ---- 2. 登录身份 ----
  let whoami = '';
  try {
    const r = await ssh.exec('id -u; whoami 2>/dev/null');
    const lines = r.stdout.trim().split('\n');
    ssh.isRoot = lines[0].trim() === '0';
    whoami = (lines[1] || '').trim();
    add('user', '检查登录身份', 'ok', ssh.isRoot ? `root（可直接修改配置）` : `${whoami || '普通用户'}（需要 sudo 密码）`);
  } catch (err) {
    ssh.isRoot = false;
    add('user', '检查登录身份', 'warn', err.message);
  }

  if (!ssh.isRoot && !sudoPassword) {
    add('user', 'sudo 密码缺失', 'warn', '非 root 登录且未填 sudo 密码，若配置失败请补充 sudo 密码');
  }

  // ---- 3. 检查 sshd 转发相关配置 ----
  let needGateway = true;
  let needForward = true;
  let raw = '';
  try {
    const r = await ssh.exec(
      "sshd -T 2>/dev/null | grep -iE '^(gatewayports|allowtcpforwarding)' ; if [ $? -ne 0 ]; then grep -iE '^[#[:space:]]*(GatewayPorts|AllowTcpForwarding)' /etc/ssh/sshd_config 2>/dev/null; fi",
      Object.assign({}, SUDO, { sudoPassword })
    );
    raw = (r.stdout || '').trim();
    const gw = /gatewayports\s+(\S+)/i.exec(raw);
    const fw = /allowtcpforwarding\s+(\S+)/i.exec(raw);
    if (gw) needGateway = !/^(yes|clientspecified)$/i.test(gw[1]);
    if (fw) needForward = !/^(yes|all)$/i.test(fw[1]);
    add('check', '检查 sshd 转发配置', 'ok',
      `GatewayPorts=${gw ? gw[1] : '默认(no)'}、AllowTcpForwarding=${fw ? fw[1] : '默认(yes)'}`);
  } catch (err) {
    add('check', '检查 sshd 转发配置', 'warn', '无法读取，将尝试直接写入配置：' + err.message);
  }

  // ---- 4. 写入配置 ----
  if (!needGateway && !needForward) {
    add('write', '写入 sshd 配置', 'skip', '已满足要求，无需修改');
  } else {
    const script = [
      "cp -n /etc/ssh/sshd_config /etc/ssh/sshd_config.portkey.bak 2>/dev/null || true",
      "sed -i -e '/# >>> lanlink >>>/d' -e '/# <<< lanlink <<</d' -e '/# >>> portkey >>>/d' -e '/# <<< portkey <<</d' -e '/^[#[:space:]]*GatewayPorts[[:space:]]/d' -e '/^[#[:space:]]*AllowTcpForwarding[[:space:]]/d' /etc/ssh/sshd_config",
      "printf '\\n# >>> portkey >>>\\nGatewayPorts clientspecified\\nAllowTcpForwarding yes\\nClientAliveInterval 30\\nClientAliveCountMax 3\\nTCPKeepAlive yes\\n# <<< portkey <<<\\n' >> /etc/ssh/sshd_config",
      "echo WROTE",
    ].join(' ; ');
    try {
      const r = await ssh.exec(script, Object.assign({}, SUDO, { sudoPassword }));
      if (!/WROTE/.test(r.stdout || '')) throw new Error((r.stderr || r.stdout || '写入失败').trim());
      add('write', '写入 sshd 配置', 'ok', '已开启 GatewayPorts / AllowTcpForwarding / 保活');
    } catch (err) {
      add('write', '写入 sshd 配置', 'error', err.message + '（非 root 请填写 sudo 密码）');
      return { ok: false, os, steps, fatal: 'write' };
    }

    // 校验语法
    try {
      const r = await ssh.exec('sshd -t 2>&1 || /usr/sbin/sshd -t 2>&1', Object.assign({}, SUDO, { sudoPassword }));
      if (r.code !== 0 || (r.stderr || '').trim()) {
        await ssh.exec('cp /etc/ssh/sshd_config.portkey.bak /etc/ssh/sshd_config 2>/dev/null || cp /etc/ssh/sshd_config.lanlink.bak /etc/ssh/sshd_config 2>/dev/null || true', Object.assign({}, SUDO, { sudoPassword }));
        add('verify', '校验 sshd 配置', 'error', '配置有误已回滚：' + (r.stderr || r.stdout || '').trim());
        return { ok: false, os, steps, fatal: 'verify' };
      }
      add('verify', '校验 sshd 配置', 'ok', '语法正确');
    } catch (err) {
      add('verify', '校验 sshd 配置', 'warn', err.message);
    }

    // 重载
    try {
      const r = await ssh.exec(
        "systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || service sshd reload 2>/dev/null || service ssh reload 2>/dev/null || (kill -HUP $(cat /var/run/sshd.pid 2>/dev/null) 2>/dev/null) || echo RELOAD_FAIL",
        Object.assign({}, SUDO, { sudoPassword })
      );
      if (/RELOAD_FAIL/.test(r.stdout || '')) {
        add('reload', '重载 sshd', 'warn', '未能自动重载，请在服务器上执行 systemctl reload sshd');
      } else {
        add('reload', '重载 sshd', 'ok', '配置已生效');
      }
    } catch (err) {
      add('reload', '重载 sshd', 'warn', err.message);
    }
  }

  // ---- 5. 防火墙放行 ----
  if (ports.length === 0) {
    add('firewall', '放行防火墙端口', 'skip', '暂无端口需要放行');
  } else {
    const list = ports.join(' ');
    const script = `for p in ${list}; do ` +
      `(command -v ufw >/dev/null 2>&1 && ufw allow $p/tcp >/dev/null 2>&1 && echo "ufw:$p") ; ` +
      `(command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --add-port=$p/tcp --permanent >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 && echo "firewalld:$p") ; ` +
      `(command -v iptables >/dev/null 2>&1 && (iptables -C INPUT -p tcp --dport $p -j ACCEPT >/dev/null 2>&1 || iptables -I INPUT -p tcp --dport $p -j ACCEPT >/dev/null 2>&1) && echo "iptables:$p") ; ` +
      `done; echo FW_DONE`;
    try {
      const r = await ssh.exec(script, Object.assign({}, SUDO, { sudoPassword }));
      const done = (r.stdout || '').split('\n').filter((l) => /:(80|.*\d)$/.test(l.trim()) && !/FW_DONE/.test(l));
      const hit = (r.stdout.match(/:(80|443|\d+)/g) || []).length;
      if (hit > 0) add('firewall', '放行防火墙端口', 'ok', `已放行 ${ports.join('、')}`);
      else add('firewall', '放行防火墙端口', 'skip', '未检测到 ufw/firewalld/iptables，或无需放行');
    } catch (err) {
      add('firewall', '放行防火墙端口', 'warn', err.message);
    }
  }

  // ---- 6. 安全组提示（无法自动）----
  add('security-group', '云服务器安全组', 'warn',
    ports.length ? `请在云控制台放行：${ports.join('、')}（安全组无法通过 SSH 修改）` : '暂无');

  return { ok: true, os, steps };
}

module.exports = { provision };
