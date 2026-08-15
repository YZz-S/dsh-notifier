/**
 * dsh-notifier — Host 半边（可安装的 dsh.bundle 插件）
 *
 * 职责：监听 agent/status（任务完成）与 approval/request（需要人工确认/输入），
 * 通过 subprocess 派生系统命令发送操作系统原生通知。
 *
 * 安装版（dsh plugin --profile web add github:YZz-S/dsh-notifier）由 cordis.patch.yml
 * 插入本插件行；动态用法（cordis_define 加载 host.js）仍保留，两种方式二选一。
 */
export const name = 'notifier'
export const inject = ['subprocess']

// PowerShell 已注册的 AppID（Windows PowerShell v1.0），据此发 Toast 无需注册表写入。
const powershellAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function appleQuote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function buildWindowsScript(title, body) {
  const t = psQuote(title)
  const b = psQuote(body)
  const toastStatements = [
    '[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]|Out-Null',
    '$et=[System.Security.SecurityElement]::Escape($t)',
    '$eb=[System.Security.SecurityElement]::Escape($b)',
    '$x=New-Object Windows.Data.Xml.Dom.XmlDocument',
    "$x.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>'+$et+'</text><text>'+$eb+'</text></binding></visual></toast>')",
    '$n=[Windows.UI.Notifications.ToastNotification]::new($x)',
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + powershellAppId + "').Show($n)",
    '$showed=$true',
  ]
  const balloonStatements = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$ni=New-Object System.Windows.Forms.NotifyIcon',
    '$ni.Icon=[System.Drawing.SystemIcons]::Information',
    '$ni.BalloonTipIcon=[System.Windows.Forms.ToolTipIcon]::Info',
    '$ni.BalloonTipTitle=$t',
    '$ni.BalloonTipText=$b',
    '$ni.Visible=$true',
    '$ni.ShowBalloonTip(8000)',
    'Start-Sleep -Milliseconds 8500',
    '$ni.Dispose()',
  ]
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    '$t=' + t,
    '$b=' + b,
    '$showed=$false',
    'try{' + toastStatements.join(';') + '}catch{}',
    'if(-not $showed){' + balloonStatements.join(';') + '}',
  ].join(';')
}

export function apply(ctx) {
  const agents = ctx.get('agents')

  // 会话标题：优先显示触发通知的会话标题，缺失时回退到品牌名。
  function sessionTitleOf(agent) {
    if (agent === undefined || agent === null) return ''
    try {
      const svc = ctx.get('sessionTitle')
      if (svc === undefined || typeof svc.get !== 'function') return ''
      const session = agent.session
      if (session === undefined || session === null) return ''
      const snap = svc.get(session)
      return snap && typeof snap.title === 'string' ? snap.title.trim() : ''
    } catch (error) {
      return ''
    }
  }

  let notifierPromise = null
  function resolveNotifier() {
    if (notifierPromise === null) {
      notifierPromise = (async () => {
        for (const cmd of ['powershell', 'osascript', 'notify-send']) {
          try {
            const path = await ctx.subprocess.resolveExecutable(cmd)
            return { cmd, path }
          } catch (error) { /* 尝试下一个平台命令 */ }
        }
        return null
      })()
    }
    return notifierPromise
  }

  function spawnFireAndForget(argv) {
    ctx.subprocess.spawn({
      argv,
      cwd: '/',
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
      graceMs: 30000,
    })
  }

  function notify(title, body) {
    resolveNotifier().then((resolved) => {
      if (resolved === null) return
      try {
        if (resolved.cmd === 'powershell') {
          spawnFireAndForget([resolved.path, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', buildWindowsScript(title, body)])
        } else if (resolved.cmd === 'osascript') {
          spawnFireAndForget([resolved.path, '-e', 'display notification ' + appleQuote(body) + ' with title ' + appleQuote(title)])
        } else if (resolved.cmd === 'notify-send') {
          spawnFireAndForget([resolved.path, '-a', 'DeepSeek Harness', title, body])
        }
      } catch (error) {
        console.error('dsh-notifier spawn failed:', error)
      }
    }).catch((error) => {
      console.error('dsh-notifier resolve failed:', error)
    })
  }

  // ---- 任务完成：顶层会话 running → idle ----
  const runningAgents = new WeakSet()
  ctx.on('agent/status', (payload) => {
    const agent = payload && payload.agent
    const status = payload && payload.status
    if (agent === undefined) return
    if (status === 'running') {
      runningAgents.add(agent)
    } else if (status === 'idle') {
      const wasRunning = runningAgents.has(agent)
      runningAgents.delete(agent)
      if (!wasRunning) return
      const isRoot = agents === undefined ? true : agents.roots().indexOf(agent) !== -1
      if (isRoot) notify(sessionTitleOf(agent) || 'DeepSeek Harness', '任务已完成')
    }
  })

  // ---- 需要确认/输入：approval/request（waterfall，务必透传 next）----
  ctx.on('approval/request', (req, next) => {
    try {
      const toolName = req && typeof req.toolName === 'string' ? req.toolName : ''
      const reason = req && typeof req.reason === 'string' ? req.reason : ''
      let body = '有一个操作需要你在页面中确认'
      if (toolName) body = '工具 ' + toolName + ' 需要你在页面中确认'
      if (reason) body = body + '：' + reason
      notify(sessionTitleOf(req && req.agent) || 'DeepSeek Harness', body)
    } catch (error) {
      console.error('dsh-notifier approval listener error:', error)
    }
    return next()
  })
}
