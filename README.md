# Lifeline

Fall detection should not stop at **"fall detected."** Lifeline turns a senior fall into a live emergency workflow: local fall detection, multilingual voice check, real backend agents, real hospital search, and call + map routing to care.

> 🔗 **API:** https://lifeline-backend-o4vr.onrender.com/api/health  
> 🏥 **Track:** Healthcare  
> 🎥 **Demo video:** TODO — video URL  
> 🌐 **Live demo:** TODO — Vercel URL

![Lifeline cover](public/lifeline-cover.svg)

---

## What it does

Lifeline watches for a possible senior fall and:

1. **Detects the fall** from browser camera frames using MoveNet body pose or a safe pen-demo CV mode.
2. **Speaks in the selected language** and asks whether the patient is okay.
3. **Listens for OK / Help** with browser speech recognition.
4. **Escalates on no response** with a visible countdown and press-and-hold cancel.
5. **Runs a live multi-agent backend** through FastAPI + Server-Sent Events.
6. **Searches real nearby hospitals** with OpenStreetMap Overpass API.
7. **Generates a Gemini dispatcher briefing** and prepares ER call + Google Maps directions.

Lifeline prepares the next human-actionable step. It does **not** pretend to dispatch an ambulance, reserve a bed, or notify a hospital without the user pressing a call link.

---

## Key features

- **Senior-first emergency UX** — voice check, no-response countdown, big safe/help buttons, and accidental-escalation cancel.
- **Multilingual flow** — choosing English or Chinese changes later prompts and recognition behavior.
- **Computer vision detection** — MoveNet body posture detection plus a camera-based pen demo for safe live presentations.
- **Real agent pipeline** — eight backend agents write to shared state and stream progress live through SSE.
- **Real hospital discovery** — `HospitalSearchAgent` calls OpenStreetMap Overpass API instead of a hardcoded hospital list.
- **Transparent medical limits** — live bed/ICU data is marked unavailable when no public feed exists; no fake capacity numbers.
- **Actionable output** — Gemini briefing, `tel:` call links, and Google Maps directions.

---

## Architecture

```mermaid
flowchart TB
  subgraph Browser["Browser / Mobile Web App"]
    Camera["Camera feed"]
    Pose["TensorFlow.js MoveNet<br/>body fall detection"]
    Pen["Canvas CV<br/>pen-demo orientation detection"]
    VoiceOut["SpeechSynthesis<br/>localized voice prompt"]
    VoiceIn["SpeechRecognition<br/>OK / Help"]
    UI["React emergency UI<br/>countdown, cancel, dispatch view"]
  end

  subgraph API["FastAPI Backend"]
    SSE["/api/dispatch/stream<br/>Server-Sent Events"]
    State["Shared emergency case state"]
  end

  subgraph Agents["Live Agent Pipeline"]
    Triage["TriageAgent<br/>severity + ESI"]
    Specialty["SpecialtyMatchAgent<br/>required care"]
    Search["HospitalSearchAgent<br/>real hospital discovery"]
    Capacity["CapacityAgent<br/>public metadata audit"]
    Routing["RoutingAgent<br/>ETA + specialty scoring"]
    Admission["AdmissionAgent<br/>ER handoff packet"]
    Gemini["GeminiReasoningAgent<br/>dispatcher briefing"]
    Notify["NotifyAgent<br/>call links + summary"]
  end

  subgraph External["External Services"]
    OSM["OpenStreetMap Overpass API"]
    GeminiAPI["Google Gemini API"]
    Maps["Google Maps directions"]
    Phone["tel: phone links"]
  end

  Camera --> Pose
  Camera --> Pen
  Pose --> UI
  Pen --> UI
  UI --> VoiceOut
  VoiceIn --> UI
  UI -->|Help / no safe response| SSE
  SSE --> State
  State --> Triage --> Specialty --> Search --> Capacity --> Routing --> Admission --> Gemini --> Notify
  Search --> OSM
  Gemini --> GeminiAPI
  Notify --> UI
  UI --> Maps
  UI --> Phone
```

---

## Agent pipeline

| Stage | What happens | Real input / tool |
| --- | --- | --- |
| Detect | Browser camera detects body posture or pen-demo fall orientation. | Webcam frames, TensorFlow.js, Canvas |
| Voice Check | Lifeline speaks in the selected language and listens for OK / Help. | Web Speech APIs |
| `TriageAgent` | Classifies emergency severity and urgency. | Symptoms, age, vitals, response status |
| `SpecialtyMatchAgent` | Maps the case to emergency, trauma, ortho, neuro, cardiac, or ICU-related needs. | Triage output |
| `HospitalSearchAgent` | Searches nearby real hospitals. | OpenStreetMap Overpass API |
| `CapacityAgent` | Audits public metadata and reports when live bed/ICU data is unavailable. | Public OSM metadata |
| `RoutingAgent` | Scores hospitals by ETA, specialty match, metadata, and phone availability. | Candidate hospitals |
| `GeminiReasoningAgent` | Generates a concise dispatcher-style explanation. | Gemini API |
| `NotifyAgent` | Prepares caregiver call, hospital call, map directions, and handoff summary. | Phone links + routing result |

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Model | Google Gemini (`gemini-3.6-flash`) via `google-genai` |
| Agent runtime | FastAPI async agents with shared backend state |
| Streaming | Server-Sent Events (`/api/dispatch/stream`) |
| Hospital data | OpenStreetMap Overpass API |
| Computer vision | TensorFlow.js MoveNet + Canvas orientation tracking |
| Voice | Browser SpeechSynthesis + SpeechRecognition |
| Backend | FastAPI + Uvicorn (Python) |
| Frontend | React 19 + Vite 8 + TypeScript |
| Routing output | Google Maps directions + `tel:` links |

---

## Hackathon context

Lifeline is built for the **Healthcare** track.

Most fall detection systems stop after sending an alert. Lifeline continues the workflow into voice verification, triage, hospital discovery, explainable routing, and human-callable next steps.

For the demo, Lifeline shows a full fall-to-care sequence: **detect → ask → listen → escalate → run agents → find hospital → brief → call/map route**.

---

## Setup & run

### Backend

```bash
pip install -r requirements.txt
copy .env.example .env
py -m uvicorn app:app --host 127.0.0.1 --port 8000
```

`.env`:

```env
GEMINI_API_KEY=your_google_ai_studio_key
GEMINI_MODEL=gemini-3.6-flash
```

### Frontend

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`.

---

## Deployment

| Service | Settings |
| --- | --- |
| Render backend | `Build Command: pip install -r requirements.txt` |
| Render backend | `Start Command: uvicorn app:app --host 0.0.0.0 --port $PORT` |
| Render env | `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-3.6-flash` |
| Vercel frontend | Vite project, `Build Command: npm run build`, `Output Directory: dist` |
| Vercel env | `VITE_API_URL=https://lifeline-backend-o4vr.onrender.com` |

The frontend uses `VITE_API_URL` for production SSE calls. Without it, local development falls back to same-origin `/api/...` paths.

---

## Demo flow

1. Choose English or Chinese.
2. Start Body AI, or switch to Pen Demo for a safe live fall simulation.
3. Trigger a fall event.
4. Lifeline speaks the emergency prompt in the selected language.
5. Respond with **OK** to return to monitoring, or choose **Request Help**.
6. Watch the backend agents run live.
7. Review the selected hospital, Gemini briefing, call links, and map directions.

---

## Real data integrity

**Real:** webcam fall detection, browser voice, FastAPI agents, SSE streaming, OpenStreetMap hospital discovery, Gemini briefing, browser GPS, `tel:` links, Google Maps directions.

**Not fabricated:** no secret ambulance dispatch, no hidden hospital notification, no invented live bed/ICU availability, no medical-device claim.

---

## Repository structure

```text
lifeline/
├── app.py                 # FastAPI backend and agent pipeline
├── src/                   # React + TypeScript frontend
├── public/                # Cover art and static demo assets
├── requirements.txt       # Python backend dependencies
├── package.json           # Frontend scripts and dependencies
├── .env.example           # Environment variable template
└── README.md
```

---

## Future work

- Verified hospital capacity API integrations
- WhatsApp/SMS caregiver alerts
- Google Maps travel-time API for live ETA
- PWA install mode for phones
- Wearable or IoT fall sensor integration
- Caregiver profiles and emergency contact management
- Clinical validation of fall and triage logic
- Emergency service workflow integrations where legally and technically possible

---

## License

Hackathon prototype. Add a license before production or public reuse.
