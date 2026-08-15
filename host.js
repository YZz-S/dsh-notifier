// dsh-notifier · Host 半部分（系统通知插件）
// 使用方式：把本文件内容整体作为 cordis_define 的 code.host 使用。
// ---------------------------------------------------------------------------
// 职责：
//   1. 监听 agent/status：顶层会话从 running 回到 idle 时，发送「任务已完成」系统通知
//   2. 监听 approval/request：需要用户在页面中确认/输入时，发送「需要确认」系统通知（不干预审批流程）
//   3. 通过 subprocess 派生系统命令发送通知：
//      - Windows：PowerShell WinRT Toast（使用已注册的 PowerShell AppID，无需写注册表），失败自动降级为气泡通知
//      - macOS：osascript display notification
//      - Linux：notify-send
// 依赖：subprocess 为可选能力（ctx.get），缺失时本插件静默停用；agents 用于过滤顶层会话，缺失时不过滤。
// 隐私：仅本地派生通知命令，不发起任何网络请求，不采集/上传数据，不写文件（Windows Toast 亦不写注册表）。
// ---------------------------------------------------------------------------
return {
  apply(ctx) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) return
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

    // PowerShell 已注册的 AppID（Windows PowerShell v1.0），据此发 Toast 无需注册表写入。
    const powershellAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

    // ---- 平台通知命令解析（惰性 + 缓存）----
    let notifierPromise = null
    function resolveNotifier() {
      if (notifierPromise === null) {
        notifierPromise = (async () => {
          for (const cmd of ['powershell', 'osascript', 'notify-send']) {
            try {
              const path = await subprocess.resolveExecutable(cmd)
              return { cmd, path }
            } catch (error) { /* 尝试下一个平台命令 */ }
          }
          return null
        })()
      }
      return notifierPromise
    }

    // ---- 字符串转义辅助 ----
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

    function spawnFireAndForget(argv) {
      subprocess.spawn({
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
  },
}
