import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Ambulance,
  Bell,
  Check,
  Clock3,
  Heart,
  Hospital,
  Languages,
  MapPin,
  Mic,
  Phone,
  Shield,
  Share2,
  Siren,
  User,
  X,
} from 'lucide-react'

declare global {
  interface Window {
    tf?: {
      setBackend: (backend: string) => Promise<void>
      ready: () => Promise<void>
    }
    poseDetection?: {
      SupportedModels: { MoveNet: string }
      movenet: { modelType: { SINGLEPOSE_LIGHTNING: string } }
      createDetector: (model: string, config: Record<string, unknown>) => Promise<PoseDetector>
    }
  }
}

type PoseKeypoint = {
  name?: string
  x: number
  y: number
  score?: number
}

type PoseResult = {
  keypoints: PoseKeypoint[]
}

type PoseDetector = {
  estimatePoses: (video: HTMLVideoElement, config?: Record<string, unknown>) => Promise<PoseResult[]>
}

type Screen = 'home' | 'critical' | 'analysis' | 'dispatch'

type HospitalRoute = {
  name: string
  eta: number
  distance: string
  score: number
  specialty: string
  reason: string
  phone?: string
  lat?: number
  lng?: number
  source?: string
  capacityNote?: string
}

type DispatchPayload = {
  patient: string
  triage: string
  recommendedHospital: HospitalRoute
  caregiver: string
  caregiverPhone?: string
  timeline: { label: string; time: string; status: 'warning' | 'danger' | 'success' | 'active' }[]
  agents: { name: string; task: string; result: string; latency: string; status: 'done' | 'active' }[]
  llmBriefing?: string
}

type AgentEvent = {
  type: 'agent'
  name: string
  task: string
  status: 'waiting' | 'active' | 'done'
  result: string
  latency: string
}

const emptyDispatch: DispatchPayload = {
  patient: 'Aunty Lim Mei',
  triage: 'Awaiting real agent run.',
  caregiver: 'Jane Chen',
  recommendedHospital: {
    name: 'No hospital selected yet',
    eta: 0,
    distance: 'Waiting for GPS + hospital API',
    score: 0,
    specialty: 'Pending',
    reason: 'Real HospitalSearchAgent has not completed.',
    phone: '',
    lat: undefined,
    lng: undefined,
    source: 'Not run',
  },
  caregiverPhone: '+1-555-010-0237',
  timeline: [
    { label: 'Fall Detected by AI', time: '10:30 AM', status: 'warning' },
    { label: 'Voice Verification No Response', time: '10:31 AM', status: 'danger' },
    { label: 'Real Hospital Search Pending', time: '10:31 AM', status: 'success' },
    { label: 'ER Call Link Pending', time: '10:32 AM', status: 'active' },
  ],
  agents: [],
  llmBriefing: '',
}

const agentTemplates = [
  { name: 'TriageAgent', task: 'ESI v4 clinical urgency assessment', result: 'Waiting for patient symptoms', latency: 'live', status: 'active' },
  { name: 'SpecialtyMatchAgent', task: 'Clinical semantic specialty mapping', result: 'Waiting for triage output', latency: 'live', status: 'active' },
  { name: 'HospitalSearchAgent', task: 'OpenStreetMap API nearby hospital discovery', result: 'Waiting for GPS + Overpass API', latency: 'live', status: 'active' },
  { name: 'CapacityAgent', task: 'Public hospital metadata capacity audit', result: 'Waiting for public metadata', latency: 'live', status: 'active' },
  { name: 'RoutingAgent', task: 'Severity-adjusted ranking', result: 'Waiting for candidate hospitals', latency: 'live', status: 'active' },
  { name: 'AdmissionAgent', task: 'Emergency call handoff packet', result: 'Waiting for selected hospital', latency: 'live', status: 'active' },
  { name: 'GeminiReasoningAgent', task: 'LLM emergency explanation and dispatcher briefing', result: 'Waiting for routing result', latency: 'live', status: 'active' },
  { name: 'NotifyAgent', task: 'Caregiver and ER call-link preparation', result: 'Waiting for call links', latency: 'live', status: 'active' },
] as const

const activityLog = [
  ['Movement detected in living room', '2:45 PM • Today'],
  ['Heart rate recorded: 72 bpm', '1:30 PM • Today'],
  ['Medication reminder acknowledged', '12:15 PM • Today'],
  ['Morning check-in completed', '10:00 AM • Today'],
  ['System activated', '9:30 AM • Today'],
]

const conditionPresets = [
  { icon: '🦴', label: 'Fall / Hip Injury', detail: 'Possible fracture' },
  { icon: '❤️', label: 'Chest Pain', detail: 'Cardiac alert' },
  { icon: '🧠', label: 'Stroke Signs', detail: 'FAST positive' },
  { icon: '🩸', label: 'Trauma', detail: 'Head impact' },
]

type FallDetectorStatus = 'idle' | 'loading' | 'monitoring' | 'fall'
type DetectionMode = 'pose' | 'prop'
type AppLanguage = 'en' | 'zh'

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')

function apiUrl(path: string) {
  return `${API_BASE}${path}`
}

const copy = {
  en: {
    code: 'GB',
    label: 'English',
    fallPrompt: 'Critical. Potential fall detected. Are you okay? Please say OK or help.',
    title: ['CRITICAL:', 'Potential Fall', 'Detected!'],
    listening: 'System is listening... Are you okay?',
    say: 'Please say OK or HELP',
    voice: 'Tap for Voice Check',
    ok: "I'M OK",
    help: 'REQUEST HELP',
    ambulance: ['Ambulance auto-call', 'in:'],
    hold: ['PRESS & HOLD 3', 'SECONDS'],
    cancel: 'TO CANCEL',
    safe: 'I am glad you are safe. Monitoring resumed.',
    dispatch: (eta: number, hospital: string) => `Emergency routing complete. Estimated drive time ${eta} minutes. Call link prepared for ${hospital}.`,
  },
  zh: {
    code: 'CN',
    label: '中文',
    fallPrompt: '紧急。检测到可能跌倒。你还好吗？请说 OK 或帮助。',
    title: ['紧急：', '检测到可能', '跌倒！'],
    listening: '系统正在聆听……你还好吗？',
    say: '请说 OK 或 HELP',
    voice: '点击语音确认',
    ok: '我没事',
    help: '请求帮助',
    ambulance: ['救护车自动呼叫', '倒计时：'],
    hold: ['长按 3 秒', '取消'],
    cancel: '取消',
    safe: '很高兴你没事。系统继续监测。',
    dispatch: (eta: number, hospital: string) => `紧急路线已完成。预计车程 ${eta} 分钟。已准备 ${hospital} 的电话链接。`,
  },
}

const tfScripts = [
  'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-core',
  'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-converter',
  'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgl',
  'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection',
]

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`)
    if (existing) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(script)
  })
}

async function loadPoseRuntime() {
  for (const src of tfScripts) {
    await loadScript(src)
  }
  if (!window.tf || !window.poseDetection) {
    throw new Error('TensorFlow pose runtime did not load')
  }
}

function midpoint(a: PoseKeypoint, b: PoseKeypoint) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function averageVisibleY(points: Array<PoseKeypoint | undefined>, fallback: number) {
  const visible = points.filter((point): point is PoseKeypoint => Boolean(point && (point.score ?? 0) > 0.2))
  if (!visible.length) return fallback
  return visible.reduce((sum, point) => sum + point.y, 0) / visible.length
}

function drawPose(ctx: CanvasRenderingContext2D, pose: PoseResult) {
  const keypoints = pose.keypoints.filter((point) => (point.score ?? 0) > 0.24)
  const byName = Object.fromEntries(keypoints.map((point) => [point.name, point]))
  const edges = [
    ['left_shoulder', 'right_shoulder'],
    ['left_shoulder', 'left_elbow'],
    ['left_elbow', 'left_wrist'],
    ['right_shoulder', 'right_elbow'],
    ['right_elbow', 'right_wrist'],
    ['left_shoulder', 'left_hip'],
    ['right_shoulder', 'right_hip'],
    ['left_hip', 'right_hip'],
    ['left_hip', 'left_knee'],
    ['left_knee', 'left_ankle'],
    ['right_hip', 'right_knee'],
    ['right_knee', 'right_ankle'],
  ]
  ctx.lineWidth = 4
  ctx.strokeStyle = '#19f7e8'
  ctx.shadowColor = '#19f7e8'
  ctx.shadowBlur = 10
  for (const [from, to] of edges) {
    const a = byName[from]
    const b = byName[to]
    if (!a || !b) continue
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
  ctx.fillStyle = '#ff5b63'
  ctx.shadowBlur = 0
  for (const point of keypoints) {
    ctx.beginPath()
    ctx.arc(point.x, point.y, 5, 0, Math.PI * 2)
    ctx.fill()
  }
}

function speak(text: string) {
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = 0.92
  utterance.pitch = 1.04
  utterance.lang = text.match(/[\u4e00-\u9fff]/) ? 'zh-CN' : 'en-US'
  window.speechSynthesis.speak(utterance)
}

function getBrowserCoords(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null)
      return
    }
    const timeout = window.setTimeout(() => resolve(null), 2600)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        window.clearTimeout(timeout)
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        })
      },
      () => {
        window.clearTimeout(timeout)
        resolve(null)
      },
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 2400 },
    )
  })
}

function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [seconds, setSeconds] = useState(59)
  const [speechStatus, setSpeechStatus] = useState('')
  const [dispatch, setDispatch] = useState<DispatchPayload>(emptyDispatch)
  const [language, setLanguage] = useState<AppLanguage>('en')
  const [selectedCondition, setSelectedCondition] = useState(conditionPresets[0].label)
  const [isListening, setIsListening] = useState(false)
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([])
  const [analysisMessage, setAnalysisMessage] = useState('Connecting to emergency agent backend...')
  const [holdProgress, setHoldProgress] = useState(0)
  const holdTimer = useRef<number | null>(null)
  const holdInterval = useRef<number | null>(null)

  const countdownPercent = useMemo(() => `${Math.max(0, (seconds / 59) * 100)}%`, [seconds])

  useEffect(() => {
    if (screen !== 'critical') return
    setSeconds(59)
    setSpeechStatus('')
    speak(copy[language].fallPrompt)
    const repeatPrompt = window.setInterval(() => {
      speak(copy[language].fallPrompt)
    }, 12000)
    return () => window.clearInterval(repeatPrompt)
  }, [screen, language])

  useEffect(() => {
    if (screen !== 'critical') return
    const timer = window.setInterval(() => {
      setSeconds((current) => {
        if (current <= 1) {
          window.clearInterval(timer)
          triggerDispatch(`No voice response after fall detection. Emergency type: ${selectedCondition}`)
          return 0
        }
        return current - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [screen])

  async function triggerDispatch(reason: string) {
    setSpeechStatus(reason)
    setAgentEvents([])
    setAnalysisMessage('Streaming live agent decisions from FastAPI...')
    setScreen('analysis')
    speak(language === 'zh' ? '紧急路由智能体已启动。' : 'Emergency routing agents activated. Triage, capacity, and hospital matching are running now.')
    const coords = await getBrowserCoords()
    const params = new URLSearchParams({
      symptoms: reason,
      location: '123 Maple Street',
      patient: 'Aunty Lim Mei',
      age: '74',
    })
    if (coords) {
      params.set('lat', String(coords.lat))
      params.set('lng', String(coords.lng))
      setAnalysisMessage('Live GPS attached. Real hospital search agent is querying nearby facilities...')
    }
    const stream = new EventSource(apiUrl(`/api/dispatch/stream?${params.toString()}`))

    stream.onmessage = (event) => {
      if (event.data === '[DONE]') {
        stream.close()
        return
      }
      const data = JSON.parse(event.data)
      if (data.type === 'agent') {
        setAgentEvents((current) => {
          const withoutDuplicate = current.filter((item) => item.name !== data.name)
          return [...withoutDuplicate, data]
        })
      }
      if (data.type === 'complete') {
        setDispatch(data.payload)
        setAnalysisMessage('Agent consensus complete. Preparing dispatch view...')
        window.setTimeout(() => {
          setScreen('dispatch')
          speak(copy[language].dispatch(data.payload.recommendedHospital.eta, data.payload.recommendedHospital.name))
        }, 600)
      }
      if (data.type === 'error') {
        setAnalysisMessage(`Real agent backend error: ${data.message || 'external hospital API did not return a usable response'}`)
      }
    }
    stream.onerror = () => {
      stream.close()
      setAnalysisMessage('Real agent stream unavailable. Backend must be running; no fake routing result is shown.')
    }
  }

  function startVoiceRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Recognition) {
      setSpeechStatus('Voice recognition is not supported in this browser.')
      speak('Voice recognition is not supported in this browser. Please use the buttons.')
      return
    }
    const recognition = new Recognition()
    recognition.lang = language === 'zh' ? 'zh-CN' : 'en-US'
    recognition.continuous = false
    recognition.interimResults = false
    recognition.onresult = (event) => {
      const text = event.results[0][0].transcript.toLowerCase()
      setSpeechStatus(`AI Detected: "${text}"`)
      if (text.includes('ok') || text.includes('okay') || text.includes('fine') || text.includes('没事') || text.includes('可以')) {
        speak(copy[language].safe)
        setScreen('home')
      }
      if (text.includes('help') || text.includes('ambulance') || text.includes('帮助')) {
        triggerDispatch(`Patient said: ${text}`)
      }
    }
    recognition.onerror = () => setSpeechStatus('Listening failed. Please tap a response.')
    recognition.onend = () => setIsListening(false)
    setIsListening(true)
    recognition.start()
  }

  function beginHoldCancel() {
    setHoldProgress(0)
    holdInterval.current = window.setInterval(() => {
      setHoldProgress((current) => Math.min(100, current + 100 / 30))
    }, 100)
    holdTimer.current = window.setTimeout(() => {
      if (holdInterval.current) window.clearInterval(holdInterval.current)
      setHoldProgress(100)
      speak(language === 'zh' ? '紧急警报已取消。系统继续监测。' : 'Emergency cancelled. Monitoring resumed.')
      setScreen('home')
    }, 3000)
  }

  function endHoldCancel() {
    if (holdTimer.current) window.clearTimeout(holdTimer.current)
    if (holdInterval.current) window.clearInterval(holdInterval.current)
    setHoldProgress(0)
  }

  return (
    <main className="stage">
      <section className={`phone ${screen}`}>
        {screen === 'home' && (
          <HomeScreen
            language={language}
            onConditionChange={setSelectedCondition}
            onFall={() => setScreen('critical')}
            setLanguage={setLanguage}
          />
        )}
        {screen === 'critical' && (
          <CriticalScreen
            countdownPercent={countdownPercent}
            isListening={isListening}
            seconds={seconds}
            speechStatus={speechStatus}
            holdProgress={holdProgress}
            language={language}
            onCancelStart={beginHoldCancel}
            onCancelEnd={endHoldCancel}
            onHelp={() => triggerDispatch(`Patient requested help. Emergency type: ${selectedCondition}`)}
            onOk={() => {
              speak(copy[language].safe)
              setScreen('home')
            }}
            onVoice={startVoiceRecognition}
          />
        )}
        {screen === 'analysis' && <AnalysisScreen agents={agentEvents} message={analysisMessage} />}
        {screen === 'dispatch' && <DispatchScreen dispatch={dispatch} onReset={() => setScreen('home')} />}
      </section>
    </main>
  )
}

function HomeScreen({
  language,
  onConditionChange,
  onFall,
  setLanguage,
}: {
  language: AppLanguage
  onConditionChange: (condition: string) => void
  onFall: () => void
  setLanguage: (language: AppLanguage) => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const detectorRef = useRef<PoseDetector | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastHipYRef = useRef<number | null>(null)
  const propPointsRef = useRef<Array<{ x: number; y: number }>>([])
  const propColorRef = useRef<{ r: number; g: number; b: number } | null>(null)
  const propSafeAngleRef = useRef<number | null>(null)
  const propCalibrationFramesRef = useRef(0)
  const fallFramesRef = useRef(0)
  const triggeredRef = useRef(false)
  const [cameraStatus, setCameraStatus] = useState<FallDetectorStatus>('idle')
  const [detectionMode, setDetectionMode] = useState<DetectionMode>('pose')
  const [condition, setCondition] = useState(conditionPresets[0].label)
  const [poseMessage, setPoseMessage] = useState('Tap Start AI Camera for real fall detection')

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      videoRef.current?.srcObject &&
        (videoRef.current.srcObject as MediaStream).getTracks().forEach((track) => track.stop())
    }
  }, [])

  async function startRealDetection() {
    if (cameraStatus === 'monitoring') return
    propSafeAngleRef.current = null
    propCalibrationFramesRef.current = 0
    fallFramesRef.current = 0
    triggeredRef.current = false
    setCameraStatus('loading')
    setPoseMessage(detectionMode === 'pose' ? 'Loading MoveNet pose detector...' : 'Starting prop fall demo camera...')
    try {
      if (detectionMode === 'pose') {
        await loadPoseRuntime()
        await window.tf!.setBackend('webgl')
        await window.tf!.ready()
        detectorRef.current = await window.poseDetection!.createDetector(
          window.poseDetection!.SupportedModels.MoveNet,
          {
            modelType: window.poseDetection!.movenet.modelType.SINGLEPOSE_LIGHTNING,
            enableSmoothing: true,
          },
        )
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: 640, height: 480 },
        audio: false,
      })
      if (!videoRef.current) return
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      setCameraStatus('monitoring')
      setPoseMessage(detectionMode === 'pose'
        ? 'MoveNet active: monitoring body orientation and sudden descent'
        : 'Auto Pen tracking active: hold pen in camera, then lay it horizontal')
      detectLoop()
    } catch (error) {
      setCameraStatus('idle')
      setPoseMessage('Camera or AI model unavailable. Use Simulate Fall for demo.')
      console.error(error)
    }
  }

  async function detectLoop() {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    const ctx = canvas.getContext('2d')
    if (ctx) {
      canvas.width = video.videoWidth || 640
      canvas.height = video.videoHeight || 480
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const fall = detectionMode === 'pose'
        ? await detectPoseFall(ctx, video, canvas.height)
        : detectPropFall(ctx, canvas.width, canvas.height)
      setPoseMessage(fall.message)
      if (fall.detected) {
        fallFramesRef.current += 1
      } else {
        fallFramesRef.current = Math.max(0, fallFramesRef.current - 1)
      }
      if (fallFramesRef.current >= (detectionMode === 'prop' ? 3 : 8) && !triggeredRef.current) {
        triggeredRef.current = true
        setCameraStatus('fall')
        speak(detectionMode === 'prop' ? `Prop fall demo detected. ${condition} emergency triggered.` : `Potential fall detected by camera pose analysis. ${condition} emergency triggered.`)
        window.setTimeout(onFall, 600)
        return
      }
    }
    rafRef.current = requestAnimationFrame(detectLoop)
  }

  async function detectPoseFall(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, height: number) {
    const detector = detectorRef.current
    if (!detector) return { detected: false, message: 'Pose detector not ready...' }
    const poses = await detector.estimatePoses(video, { maxPoses: 1, flipHorizontal: false })
    if (!poses[0]) return { detected: false, message: 'Searching for full body pose...' }
    drawPose(ctx, poses[0])
    return evaluateFall(poses[0], height)
  }

  function handleCanvasClick(event: React.PointerEvent<HTMLCanvasElement>) {
    if (detectionMode !== 'prop' || cameraStatus === 'idle') return
    const canvas = event.currentTarget
    const rect = canvas.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height
    propPointsRef.current = [...propPointsRef.current.slice(-1), { x, y }]
    if (propPointsRef.current.length < 2) {
      setPoseMessage('Pen Demo: tap the other end of the pen')
    } else {
      const ctx = canvas.getContext('2d')
      if (ctx) {
        propColorRef.current = sampleAverageColor(ctx, propPointsRef.current)
      }
      setPoseMessage('Pen Demo calibrated: tracking pen orientation live')
    }
  }

  function detectPropFall(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const calibrated = propPointsRef.current
    if (calibrated.length === 2) {
      const tracked = trackPropFromCalibration(ctx, width, height, calibrated)
      const [a, b] = tracked ?? calibrated
      if (tracked) {
        propPointsRef.current = tracked
      }
      const dx = b.x - a.x
      const dy = b.y - a.y
      const angle = Math.abs(Math.atan2(dy, dx) * (180 / Math.PI))
      const horizontalAngle = Math.min(angle, 180 - angle)
      const horizontal = horizontalAngle < 35
      ctx.strokeStyle = horizontal ? '#ff454b' : '#35cf78'
      ctx.lineWidth = 7
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
      for (const point of calibrated) {
        ctx.beginPath()
        ctx.fillStyle = '#ff454b'
        ctx.arc(point.x, point.y, 8, 0, Math.PI * 2)
        ctx.fill()
      }
      drawPropGuide(ctx, width, height, horizontal ? 'PEN FALL DETECTED' : 'Pen calibrated / safe')
      return {
        detected: horizontal,
        message: horizontal
          ? `Prop Demo fall: calibrated pen is horizontal (${Math.round(horizontalAngle)}°)`
          : `Prop Demo tracking pen: rotate horizontal (${Math.round(horizontalAngle)}°)`,
      }
    }

    const auto = autoDetectPenOrientation(ctx, width, height)
    if (auto) {
      if (propCalibrationFramesRef.current < 24) {
        propCalibrationFramesRef.current += 1
        fallFramesRef.current = 0
        propSafeAngleRef.current = propSafeAngleRef.current === null
          ? auto.horizontalAngle
          : propSafeAngleRef.current * 0.85 + auto.horizontalAngle * 0.15
        ctx.strokeStyle = '#35cf78'
        ctx.lineWidth = 7
        ctx.beginPath()
        ctx.moveTo(auto.a.x, auto.a.y)
        ctx.lineTo(auto.b.x, auto.b.y)
        ctx.stroke()
        drawPropGuide(ctx, width, height, 'Learning safe pen position')
        return {
          detected: false,
          message: `Auto Pen calibration: hold pen in safe/upright position (${propCalibrationFramesRef.current}/24)`,
        }
      }
      const safeAngle = propSafeAngleRef.current ?? 90
      const angleDelta = Math.abs(auto.horizontalAngle - safeAngle)
      const horizontal = auto.horizontalAngle < 32 && angleDelta > 22
      ctx.strokeStyle = horizontal ? '#ff454b' : '#35cf78'
      ctx.lineWidth = 7
      ctx.beginPath()
      ctx.moveTo(auto.a.x, auto.a.y)
      ctx.lineTo(auto.b.x, auto.b.y)
      ctx.stroke()
      ctx.fillStyle = '#ff454b'
      for (const point of [auto.a, auto.b]) {
        ctx.beginPath()
        ctx.arc(point.x, point.y, 8, 0, Math.PI * 2)
        ctx.fill()
      }
      drawPropGuide(ctx, width, height, horizontal ? 'PEN FALL DETECTED' : 'Auto pen tracking')
      return {
        detected: horizontal,
        message: horizontal
          ? `Auto Pen fall: horizontal pen detected (${Math.round(auto.horizontalAngle)}°)`
          : `Auto Pen safe: ${Math.round(auto.horizontalAngle)}° now, safe ${Math.round(safeAngle)}°`,
      }
    }

    const sampleStep = 5
    const image = ctx.getImageData(0, 0, width, height).data
    let count = 0
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    for (let y = 0; y < height; y += sampleStep) {
      for (let x = 0; x < width; x += sampleStep) {
        const index = (y * width + x) * 4
        const r = image[index]
        const g = image[index + 1]
        const b = image[index + 2]
        const redPen = r > 120 && r > g * 1.25 && r > b * 1.25
        const yellowPen = r > 135 && g > 120 && b < 105 && Math.abs(r - g) < 75
        const bluePen = b > 135 && r < 115 && g < 150 && b > r * 1.25
        if (!redPen && !yellowPen && !bluePen) continue
        count += 1
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
    if (count < 18) {
      drawPropGuide(ctx, width, height, 'Tap both ends of the pen')
      return { detected: false, message: 'Pen Demo: tap one end of the pen, then tap the other end' }
    }
    const boxWidth = maxX - minX
    const boxHeight = maxY - minY
    const ratio = boxWidth / Math.max(boxHeight, 1)
    const horizontal = ratio > 1.18 && boxWidth > width * 0.2 && boxHeight < height * 0.32
    ctx.strokeStyle = horizontal ? '#ff454b' : '#35cf78'
    ctx.lineWidth = 5
    ctx.setLineDash([10, 8])
    ctx.strokeRect(minX, minY, boxWidth, boxHeight)
    ctx.setLineDash([])
    drawPropGuide(ctx, width, height, horizontal ? 'PEN FALL DETECTED' : 'Pen upright / safe')
    return {
      detected: horizontal,
      message: horizontal
        ? `Prop Demo fall: horizontal object detected (${ratio.toFixed(1)} ratio)`
        : `Optional auto mode safe. For stable demo, tap both pen ends (${ratio.toFixed(1)} ratio)`,
    }
  }

  function autoDetectPenOrientation(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const image = ctx.getImageData(0, 0, width, height).data
    const step = 4
    const candidates: Array<{ x: number; y: number }> = []
    const centerX = width / 2
    const centerY = height / 2
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const index = (y * width + x) * 4
        const r = image[index]
        const g = image[index + 1]
        const b = image[index + 2]
        const brightness = (r + g + b) / 3
        const saturation = Math.max(r, g, b) - Math.min(r, g, b)
        const yellowHighlighter = r > 135 && g > 120 && b < 105 && Math.abs(r - g) < 75
        const redPen = r > 145 && g < 115 && b < 115 && r > g * 1.35 && r > b * 1.35
        const bluePen = b > 135 && r < 115 && g < 150 && b > r * 1.25
        const penLike = yellowHighlighter || redPen || bluePen
        const centralWeight = Math.abs(x - centerX) < width * 0.44 && Math.abs(y - centerY) < height * 0.44
        if (penLike && centralWeight) {
          candidates.push({ x, y })
        }
      }
    }
    if (candidates.length < 26) return null

    const clusters = clusterPoints(candidates, 30)
      .filter((cluster) => cluster.length >= 12)
      .map((cluster) => orientationFromPoints(cluster))
      .filter((shape): shape is NonNullable<ReturnType<typeof orientationFromPoints>> => Boolean(shape))
      .filter((shape) => shape.length > 78 && shape.thinness > 2.2 && shape.area < width * height * 0.08)
      .sort((a, b) => b.length * b.thinness - a.length * a.thinness)

    return clusters[0] ?? null
  }

  function clusterPoints(points: Array<{ x: number; y: number }>, cell: number) {
    const buckets = new Map<string, Array<{ x: number; y: number }>>()
    for (const point of points) {
      const key = `${Math.floor(point.x / cell)}:${Math.floor(point.y / cell)}`
      const bucket = buckets.get(key) ?? []
      bucket.push(point)
      buckets.set(key, bucket)
    }
    const visited = new Set<string>()
    const clusters: Array<Array<{ x: number; y: number }>> = []
    for (const key of buckets.keys()) {
      if (visited.has(key)) continue
      const queue = [key]
      const cluster: Array<{ x: number; y: number }> = []
      visited.add(key)
      while (queue.length) {
        const current = queue.shift()!
        const [cx, cy] = current.split(':').map(Number)
        cluster.push(...(buckets.get(current) ?? []))
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const next = `${cx + ox}:${cy + oy}`
            if (visited.has(next) || !buckets.has(next)) continue
            visited.add(next)
            queue.push(next)
          }
        }
      }
      clusters.push(cluster)
    }
    return clusters
  }

  function orientationFromPoints(points: Array<{ x: number; y: number }>) {
    const mean = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 })
    mean.x /= points.length
    mean.y /= points.length
    let sxx = 0
    let syy = 0
    let sxy = 0
    for (const point of points) {
      const dx = point.x - mean.x
      const dy = point.y - mean.y
      sxx += dx * dx
      syy += dy * dy
      sxy += dx * dy
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    const axis = { x: Math.cos(angle), y: Math.sin(angle) }
    let minProjection = Infinity
    let maxProjection = -Infinity
    let perpendicularEnergy = 0
    for (const point of points) {
      const dx = point.x - mean.x
      const dy = point.y - mean.y
      const projection = dx * axis.x + dy * axis.y
      const perpendicular = -dx * axis.y + dy * axis.x
      minProjection = Math.min(minProjection, projection)
      maxProjection = Math.max(maxProjection, projection)
      perpendicularEnergy += Math.abs(perpendicular)
    }
    const length = maxProjection - minProjection
    const averageThickness = perpendicularEnergy / points.length
    const thinness = length / Math.max(averageThickness * 2, 1)
    const rawAngle = Math.abs(angle * (180 / Math.PI))
    const horizontalAngle = Math.min(rawAngle, 180 - rawAngle)
    return {
      a: { x: mean.x + axis.x * minProjection, y: mean.y + axis.y * minProjection },
      b: { x: mean.x + axis.x * maxProjection, y: mean.y + axis.y * maxProjection },
      length,
      thinness,
      horizontalAngle,
      area: points.length * 16,
    }
  }

  function sampleAverageColor(ctx: CanvasRenderingContext2D, points: Array<{ x: number; y: number }>) {
    const image = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data
    let r = 0
    let g = 0
    let b = 0
    let count = 0
    for (const point of points) {
      for (let oy = -8; oy <= 8; oy += 4) {
        for (let ox = -8; ox <= 8; ox += 4) {
          const x = Math.max(0, Math.min(ctx.canvas.width - 1, Math.round(point.x + ox)))
          const y = Math.max(0, Math.min(ctx.canvas.height - 1, Math.round(point.y + oy)))
          const index = (y * ctx.canvas.width + x) * 4
          r += image[index]
          g += image[index + 1]
          b += image[index + 2]
          count += 1
        }
      }
    }
    return { r: r / count, g: g / count, b: b / count }
  }

  function trackPropFromCalibration(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    previous: Array<{ x: number; y: number }>,
  ) {
    const color = propColorRef.current
    const image = ctx.getImageData(0, 0, width, height).data
    const center = midpoint(previous[0], previous[1])
    const prevDx = previous[1].x - previous[0].x
    const prevDy = previous[1].y - previous[0].y
    const previousLength = Math.max(60, Math.hypot(prevDx, prevDy))
    const searchRadius = Math.min(Math.max(previousLength * 1.8, 150), 260)
    const candidates: Array<{ x: number; y: number }> = []
    const step = 4
    const minX = Math.max(0, Math.floor(center.x - searchRadius))
    const maxX = Math.min(width - 1, Math.ceil(center.x + searchRadius))
    const minY = Math.max(0, Math.floor(center.y - searchRadius))
    const maxY = Math.min(height - 1, Math.ceil(center.y + searchRadius))
    for (let y = minY; y <= maxY; y += step) {
      for (let x = minX; x <= maxX; x += step) {
        const index = (y * width + x) * 4
        const r = image[index]
        const g = image[index + 1]
        const b = image[index + 2]
        const redOrYellow = (r > 120 && r > b * 1.2 && g > 70) || (r > 135 && g > 105 && b < 130)
        const dark = r < 95 && g < 95 && b < 95
        const colorClose = color
          ? Math.abs(r - color.r) + Math.abs(g - color.g) + Math.abs(b - color.b) < 150
          : false
        const saturated = Math.max(r, g, b) - Math.min(r, g, b) > 45 && (r + g + b) / 3 < 220
        if (redOrYellow || dark || colorClose || saturated) {
          candidates.push({ x, y })
        }
      }
    }
    if (candidates.length < 12) return null
    const mean = candidates.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 })
    mean.x /= candidates.length
    mean.y /= candidates.length
    let sxx = 0
    let syy = 0
    let sxy = 0
    for (const point of candidates) {
      const dx = point.x - mean.x
      const dy = point.y - mean.y
      sxx += dx * dx
      syy += dy * dy
      sxy += dx * dy
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    const axis = { x: Math.cos(angle), y: Math.sin(angle) }
    let minProjection = Infinity
    let maxProjection = -Infinity
    for (const point of candidates) {
      const projection = (point.x - mean.x) * axis.x + (point.y - mean.y) * axis.y
      minProjection = Math.min(minProjection, projection)
      maxProjection = Math.max(maxProjection, projection)
    }
    const trackedLength = maxProjection - minProjection
    if (trackedLength < 45) return null
    return [
      { x: mean.x + axis.x * minProjection, y: mean.y + axis.y * minProjection },
      { x: mean.x + axis.x * maxProjection, y: mean.y + axis.y * maxProjection },
    ]
  }

  function drawPropGuide(ctx: CanvasRenderingContext2D, width: number, _height: number, label: string) {
    ctx.fillStyle = 'rgba(17, 24, 39, 0.78)'
    ctx.fillRect(12, 12, Math.min(width - 24, 280), 34)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 17px Inter, sans-serif'
    ctx.fillText(label, 24, 35)
  }

  function evaluateFall(pose: PoseResult, height: number) {
    const keypoints = Object.fromEntries(pose.keypoints.map((point) => [point.name, point]))
    const leftShoulder = keypoints.left_shoulder
    const rightShoulder = keypoints.right_shoulder
    const leftHip = keypoints.left_hip
    const rightHip = keypoints.right_hip
    const leftAnkle = keypoints.left_ankle
    const rightAnkle = keypoints.right_ankle
    const required = [leftShoulder, rightShoulder, leftHip, rightHip]
    if (required.some((point) => !point || (point.score ?? 0) < 0.25)) {
      return { detected: false, message: 'Searching for full body pose...' }
    }
    const shoulder = midpoint(leftShoulder, rightShoulder)
    const hip = midpoint(leftHip, rightHip)
    const ankleY = averageVisibleY([leftAnkle, rightAnkle], height)
    const torsoDx = Math.abs(shoulder.x - hip.x)
    const torsoDy = Math.abs(shoulder.y - hip.y)
    const horizontalBody = torsoDx > torsoDy * 1.28
    const hipLow = hip.y > height * 0.55
    const nearFloor = ankleY > height * 0.62
    const previousHipY = lastHipYRef.current
    lastHipYRef.current = hip.y
    const rapidDrop = previousHipY !== null && hip.y - previousHipY > height * 0.035
    const detected = (horizontalBody && hipLow) || (rapidDrop && hipLow) || (horizontalBody && nearFloor)
    const message = detected
      ? 'Potential fall pattern: horizontal posture / low hip / rapid descent'
      : `Monitoring posture: torso ${Math.round(torsoDx)}x${Math.round(torsoDy)}`
    return { detected, message }
  }

  return (
    <div className="screen home-screen">
      <header className="topbar">
        <div className="app-logo">
          <Activity size={22} />
        </div>
        <strong>Lifeline</strong>
        <span className="secure-dot">SECURE</span>
      </header>

      <div className="privacy-banner">
        <Shield size={13} />
        Local Processing Only • Privacy First
      </div>

      <section className="live-card">
        <div className="section-title">
          <h2>Edge-AI Live Feed</h2>
          <span className="live-dot">LIVE</span>
        </div>
        <div className="camera-frame">
          {cameraStatus === 'idle' ? <img src="/skeleton.png" alt="AI skeleton tracking in living room" /> : null}
          <video ref={videoRef} className={cameraStatus === 'idle' ? 'hidden-video' : 'pose-video'} muted playsInline />
          <canvas
            ref={canvasRef}
            className={cameraStatus === 'idle' ? 'hidden-canvas' : 'pose-canvas'}
            onPointerDown={handleCanvasClick}
          />
          <div className={`status-ribbon ${cameraStatus === 'fall' ? 'falling' : ''}`}>
            {cameraStatus === 'monitoring' ? 'AI MONITORING' : cameraStatus === 'loading' ? 'LOADING AI' : cameraStatus === 'fall' ? 'FALL DETECTED' : 'FALL DETECTED'}
          </div>
          <div className="camera-label">Living Room • CAM-01</div>
          {cameraStatus === 'idle' && <div className="tracking-box" />}
        </div>
        <p className="caption">Privacy Secured: All AI processing on local device</p>
        <p className="pose-message">{poseMessage}</p>
        <div className="condition-grid">
          {conditionPresets.map((item) => (
            <button
              className={condition === item.label ? 'active' : ''}
              key={item.label}
              onClick={() => {
                setCondition(item.label)
                onConditionChange(item.label)
              }}
              type="button"
            >
              <span>{item.icon}</span>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </button>
          ))}
        </div>
        <div className="mode-switch" role="group" aria-label="Detection mode">
          <button
            className={detectionMode === 'pose' ? 'active' : ''}
            onClick={() => setDetectionMode('pose')}
            type="button"
          >
            Body AI
          </button>
          <button
            className={detectionMode === 'prop' ? 'active' : ''}
            onClick={() => {
              setDetectionMode('prop')
              propPointsRef.current = []
              setPoseMessage('Pen Demo: auto detects pen angle from camera frames')
            }}
            type="button"
          >
            Pen Demo
          </button>
        </div>
        <button className="camera-button" onClick={startRealDetection} type="button">
          <Activity size={17} />
          {cameraStatus === 'idle' ? detectionMode === 'prop' ? 'Start Pen Demo Camera' : 'Start AI Camera' : cameraStatus === 'loading' ? 'Loading AI Model...' : 'Real Fall Detection Active'}
        </button>
      </section>

      <div className="mini-grid">
        <InfoTile icon={<Languages size={19} />} title="Multi-Language">
          <div className="language-picker">
            {(['en', 'zh'] as AppLanguage[]).map((item) => (
              <button
                className={language === item ? 'active' : ''}
                key={item}
                onClick={() => setLanguage(item)}
                type="button"
              >
                {copy[item].code} {copy[item].label}
              </button>
            ))}
          </div>
          <b>{copy[language].label} Active</b>
        </InfoTile>
        <InfoTile icon={<Heart size={19} />} title="Vital Tracking">
          <small>Heart Rate</small>
          <strong className="heart-rate">110 <em>bpm</em></strong>
          <b className="elevated">Elevated</b>
        </InfoTile>
      </div>

      <button className="simulate-button" onClick={onFall} type="button">
        <Siren size={28} />
        Simulate Fall
      </button>

      <section className="activity-card">
        <h2><Clock3 size={18} /> Activity Log</h2>
        {activityLog.map(([label, time]) => (
          <div className="log-row" key={label}>
            <span className="green-pulse" />
            <div>
              <strong>{label}</strong>
              <small>{time}</small>
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}

function CriticalScreen({
  seconds,
  countdownPercent,
  speechStatus,
  isListening,
  onOk,
  onHelp,
  onVoice,
  onCancelStart,
  onCancelEnd,
  holdProgress,
  language,
}: {
  seconds: number
  countdownPercent: string
  speechStatus: string
  isListening: boolean
  onOk: () => void
  onHelp: () => void
  onVoice: () => void
  onCancelStart: () => void
  onCancelEnd: () => void
  holdProgress: number
  language: AppLanguage
}) {
  const t = copy[language]
  return (
    <div className="screen critical-screen">
      <div className="warning-orb">
        <Siren size={52} />
      </div>
      <div className="waveform">
        {Array.from({ length: 28 }).map((_, index) => <i key={index} />)}
      </div>
      <h1>{t.title.map((line) => <span key={line}>{line}</span>)}</h1>
      <p className="listening">{t.listening}</p>
      <div className="speech-box">
        {t.say}
      </div>
      <button className={`voice-button ${isListening ? 'active' : ''}`} onClick={onVoice} type="button">
        <Mic size={18} />
        {t.voice}
      </button>
      {speechStatus && <p className="speech-status">{speechStatus}</p>}
      <div className="countdown-card">
        <div className="countdown-copy">
          <span className="countdown-icon"><Ambulance size={20} /></span>
          <div>
            <strong>{t.ambulance[0]}</strong>
            <small>{t.ambulance[1]}</small>
          </div>
        </div>
        <span className="countdown-time">{seconds}s</span>
        <div className="bar"><i style={{ width: countdownPercent }} /></div>
      </div>
      <button className="ok-button" onClick={onOk} type="button">
        <Check size={25} />
        {t.ok}
      </button>
      <button className="help-button" onClick={onHelp} type="button">
        <Ambulance size={25} />
        {t.help}
      </button>
      <button
        className="hold-button"
        onMouseDown={onCancelStart}
        onMouseUp={onCancelEnd}
        onMouseLeave={onCancelEnd}
        onTouchStart={onCancelStart}
        onTouchEnd={onCancelEnd}
        type="button"
      >
        <span className="hold-fill" style={{ width: `${holdProgress}%` }} />
        <span className="hold-label">
          {t.hold.map((line) => <span key={line}>{line}<br /></span>)}
          <small>{holdProgress > 0 ? `${Math.ceil((100 - holdProgress) / 33.34)}s ${t.cancel}` : t.cancel}</small>
        </span>
      </button>
    </div>
  )
}

function DispatchScreen({ dispatch, onReset }: { dispatch: DispatchPayload; onReset: () => void }) {
  const destination =
    dispatch.recommendedHospital.lat && dispatch.recommendedHospital.lng
      ? `${dispatch.recommendedHospital.lat},${dispatch.recommendedHospital.lng}`
      : encodeURIComponent(dispatch.recommendedHospital.name)
  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`

  return (
    <div className="screen dispatch-screen">
      <header className="dispatch-header">
        <span className="dispatch-kicker">Golden-hour routing active</span>
        <h1>Emergency Route Ready</h1>
        <p>ETA {dispatch.recommendedHospital.eta} min • {dispatch.recommendedHospital.name} call link ready</p>
      </header>

      <section className="dispatch-summary">
        <div>
          <small>Clinical priority</small>
          <strong>ESI-2 Critical</strong>
        </div>
        <div>
          <small>Selected facility</small>
          <strong>{dispatch.recommendedHospital.score}/100 match</strong>
        </div>
      </section>

      <section className="map-card">
        <div className="map-title">
          <span><MapPin size={17} /> Live GPS Location</span>
          <i />
        </div>
        <a className="route-map" href={directionsUrl} target="_blank" rel="noreferrer" aria-label={`Open directions to ${dispatch.recommendedHospital.name}`}>
          <div className="map-grid" />
          <div className="route-line" />
          <span className="ambulance-pin">🚑</span>
          <span className="patient-pin"><MapPin size={26} /></span>
          <strong>{dispatch.recommendedHospital.distance.replace(' away', '')}</strong>
          <em>Directions</em>
        </a>
        <div className="address-row">
          <span><MapPin size={20} /></span>
          <div>
            <strong>123 Maple Street</strong>
            <small>Live browser GPS area</small>
          </div>
        </div>
      </section>

      <div className="contact-grid">
        <ContactCard
          color="purple"
          icon={<User size={28} />}
          title={dispatch.caregiver}
          subtitle="Main Caregiver"
          button="Call Now"
          phone={dispatch.caregiverPhone ?? '+1-555-010-0237'}
        />
        <ContactCard
          color="red"
          icon={<Hospital size={28} />}
          title={dispatch.recommendedHospital.name}
          subtitle={dispatch.recommendedHospital.distance}
          button="Call ER"
          phone={dispatch.recommendedHospital.phone ?? '+1-555-010-0911'}
        />
      </div>

      <section className="timeline-card">
        <h2><Clock3 size={18} /> Emergency Timeline</h2>
        {dispatch.timeline.map((item) => (
          <div className="timeline-row" key={item.label}>
            <span className={`timeline-dot ${item.status}`}>{item.status === 'active' ? <Check size={13} /> : item.status === 'danger' ? <X size={13} /> : '!'}</span>
            <div>
              <strong>{item.label}</strong>
              <small>{item.time}</small>
              {item.status === 'active' && <em>In Progress</em>}
            </div>
          </div>
        ))}
      </section>

      <section className="routing-card">
        <h2>AI Routing Decision</h2>
        <p>{dispatch.triage}</p>
        <b>{dispatch.recommendedHospital.score}/100 clinical score</b>
        <small>{dispatch.recommendedHospital.reason}</small>
        {dispatch.recommendedHospital.source && (
          <small>Hospital source: {dispatch.recommendedHospital.source}</small>
        )}
        {dispatch.llmBriefing && <div className="llm-briefing">{dispatch.llmBriefing}</div>}
      </section>

      <section className="agent-card">
        <h2><Bell size={18} /> Live Multi-Agent Run</h2>
        {dispatch.agents.map((agent) => (
          <div className={`compact-agent ${agent.name.includes('Gemini') ? 'gemini-agent' : ''}`} key={agent.name}>
            <Check size={14} />
            <div>
              <strong>{agent.name}</strong>
              <small>{agent.result}</small>
            </div>
            <em>{agent.latency}</em>
          </div>
        ))}
      </section>

      <button className="share-button" type="button">
        <Share2 size={18} />
        Share Location
      </button>
      <button className="reset-button" onClick={onReset} type="button">
        Reset Demo
      </button>
    </div>
  )
}

function AnalysisScreen({ agents, message }: { agents: AgentEvent[]; message: string }) {
  const agentMap = new Map(agents.map((agent) => [agent.name, agent]))
  return (
    <div className="screen analysis-screen">
      <div className="analysis-loader" />
      <h1>Agents Running</h1>
      <p>{message}</p>
      <div className="agent-run-meta">
        <span>SSE live stream</span>
        <span>Shared state</span>
        <span>Gemini briefing</span>
      </div>
      <div className="analysis-stack">
        {agentTemplates.map((agent, index) => {
          const live = agentMap.get(agent.name)
          const state = live?.status ?? (index === 0 && agents.length === 0 ? 'active' : 'waiting')
          return (
            <section className={`analysis-agent ${state}`} key={agent.name}>
              <span>{state === 'done' ? <Check size={16} /> : state === 'active' ? <Activity size={16} /> : '⌛'}</span>
              <div>
                <strong>{agent.name}</strong>
                <small>{live?.task ?? agent.task}</small>
                {state !== 'waiting' && <p>{live?.result || 'Running agent tool...'}</p>}
              </div>
              {state !== 'waiting' && <em>{live?.latency || 'live'}</em>}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function InfoTile({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="info-tile">
      <h3>{icon}{title}</h3>
      {children}
    </section>
  )
}

function ContactCard({
  color,
  icon,
  title,
  subtitle,
  button,
  phone,
}: {
  color: 'purple' | 'red'
  icon: ReactNode
  title: string
  subtitle: string
  button: string
  phone: string
}) {
  return (
    <section className="contact-card">
      <div className={`contact-icon ${color}`}>{icon}</div>
      <strong>{title}</strong>
      <small>{subtitle}</small>
      <a className={color === 'purple' ? 'call-green' : 'call-red'} href={`tel:${phone}`}>
        <Phone size={15} />
        {button}
      </a>
    </section>
  )
}

export default App
