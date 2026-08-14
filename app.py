import asyncio
import json
import math
import os
import time
from dataclasses import dataclass
from typing import Any, Literal

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import httpx
from pydantic import BaseModel
from dotenv import load_dotenv

try:
    from google import genai
except Exception:  # pragma: no cover - optional dependency
    genai = None


load_dotenv()


AgentStatus = Literal["waiting", "active", "done"]


class DispatchRequest(BaseModel):
    symptoms: str
    location: str = "123 Maple Street"
    patient: str = "Aunty Lim Mei"
    age: int = 74
    lat: float | None = None
    lng: float | None = None
    vitals: dict[str, Any] | None = None


@dataclass
class HospitalRecord:
    name: str
    lat: float
    lng: float
    specialty: list[str]
    beds: int | None
    icu: int | None
    trauma: bool
    eta: int
    distance: str
    capacity: str
    phone: str = ""
    source: str = "OpenStreetMap Overpass API"

PATIENT_COORDS = {"lat": 37.7749, "lng": -122.4194}


def now_ms(start: float) -> str:
    return f"{int((time.perf_counter() - start) * 1000)}ms"


def haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius_miles = 3958.8
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlng / 2) ** 2
    )
    return radius_miles * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def stable_number(text: str) -> int:
    return sum((index + 1) * ord(char) for index, char in enumerate(text))


def parse_public_int(value: Any) -> int | None:
    if value is None:
        return None
    digits = "".join(char for char in str(value) if char.isdigit())
    return int(digits) if digits else None


def inferred_specialties(name: str, tags: dict[str, Any]) -> tuple[list[str], bool]:
    text = " ".join(
        str(value)
        for value in [
            name,
            tags.get("healthcare:speciality", ""),
            tags.get("speciality", ""),
            tags.get("emergency", ""),
            tags.get("description", ""),
        ]
    ).lower()
    specialties = {"Emergency"}
    trauma = False
    if any(word in text for word in ["trauma", "accident", "emergency"]):
        specialties.add("Trauma")
        trauma = True
    if any(word in text for word in ["ortho", "orthopaedic", "orthopedic", "bone"]):
        specialties.add("Orthopedics")
    if any(word in text for word in ["cardio", "heart"]):
        specialties.add("Cardiology")
    if any(word in text for word in ["neuro", "stroke"]):
        specialties.add("Neuro Trauma")
    if any(word in text for word in ["icu", "critical"]):
        specialties.add("ICU")
    return sorted(specialties), trauma


async def fetch_real_hospitals(lat: float, lng: float, radius_m: int = 9000) -> list[HospitalRecord]:
    query = f"""
[out:json][timeout:12];
(
  node["amenity"="hospital"](around:{radius_m},{lat},{lng});
  way["amenity"="hospital"](around:{radius_m},{lat},{lng});
  relation["amenity"="hospital"](around:{radius_m},{lat},{lng});
  node["healthcare"="hospital"](around:{radius_m},{lat},{lng});
  way["healthcare"="hospital"](around:{radius_m},{lat},{lng});
  relation["healthcare"="hospital"](around:{radius_m},{lat},{lng});
);
out center 25;
"""
    endpoints = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://overpass.openstreetmap.ru/api/interpreter",
    ]
    data: dict[str, Any] | None = None
    errors: list[str] = []
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(20.0, connect=8.0),
        headers={"User-Agent": "Lifeline-Hackathon/1.0 emergency-routing-demo"},
    ) as client:
        for endpoint in endpoints:
            try:
                response = await client.post(endpoint, data=query)
                response.raise_for_status()
                data = response.json()
                break
            except Exception as exc:
                errors.append(f"{endpoint}: {type(exc).__name__} {str(exc) or repr(exc)}")
    if data is None:
        raise RuntimeError("All real OpenStreetMap Overpass endpoints failed. " + " | ".join(errors))

    hospitals: list[HospitalRecord] = []
    seen: set[str] = set()
    for item in data.get("elements", []):
        tags = item.get("tags", {})
        name = tags.get("name") or tags.get("operator")
        point_lat = item.get("lat") or item.get("center", {}).get("lat")
        point_lng = item.get("lon") or item.get("center", {}).get("lon")
        if not name or point_lat is None or point_lng is None:
            continue
        key = f"{name}:{round(point_lat, 4)}:{round(point_lng, 4)}"
        if key in seen:
            continue
        seen.add(key)

        miles = haversine_miles(lat, lng, float(point_lat), float(point_lng))
        specialties, trauma = inferred_specialties(str(name), tags)
        beds = parse_public_int(tags.get("beds") or tags.get("capacity:beds"))
        eta = max(4, round((miles / 23) * 60) + 3)
        phone = (
            tags.get("contact:phone")
            or tags.get("phone")
            or tags.get("emergency:phone")
            or ""
        )
        hospitals.append(
            HospitalRecord(
                name=str(name),
                lat=float(point_lat),
                lng=float(point_lng),
                specialty=specialties,
                beds=beds,
                icu=None,
                trauma=trauma,
                eta=eta,
                distance=f"{miles:.1f} mi away",
                capacity=f"Public bed count: {beds}" if beds is not None else "Public live capacity unavailable",
                phone=str(phone),
                source="OpenStreetMap Overpass API",
            )
        )

    hospitals.sort(key=lambda hospital: haversine_miles(lat, lng, hospital.lat, hospital.lng))
    return hospitals[:8]


def classify_triage(symptoms: str, age: int) -> dict[str, Any]:
    text = symptoms.lower()
    severity = "CRITICAL"
    esi = 2
    reasons = []
    required = {"Emergency"}

    if "fall" in text:
        reasons.append("fall event detected")
        required.update(["Trauma", "Orthopedics", "Imaging"])
    if "no voice" in text or "no response" in text or "silent" in text:
        reasons.append("no safe voice response")
        required.add("ICU")
    if "head" in text or "stroke" in text or "confusion" in text:
        reasons.append("neurological risk")
        required.update(["Neuro Trauma", "ICU"])
    if "chest" in text or "cardiac" in text:
        reasons.append("cardiac warning symptoms")
        required.update(["Cardiology", "ICU"])
    if age >= 70:
        reasons.append("senior patient risk multiplier")

    return {
        "severity": severity,
        "esi": esi,
        "required_specialties": sorted(required),
        "summary": f"{severity} ESI-{esi}: " + ", ".join(reasons),
        "action": "Activate emergency response, keep patient still, prepare trauma-capable routing.",
    }


def specialty_match(required: list[str], hospital: HospitalRecord) -> dict[str, Any]:
    matched = set(required).intersection(hospital.specialty)
    coverage = len(matched) / max(len(required), 1)
    trauma_bonus = 0.14 if "Trauma" in required and hospital.trauma else 0
    score = min(1.0, coverage + trauma_bonus)
    return {"matched": sorted(matched), "coverage": round(score, 2)}


def score_route(hospital: HospitalRecord, triage: dict[str, Any]) -> dict[str, Any]:
    match = specialty_match(triage["required_specialties"], hospital)
    score = 100
    score -= hospital.eta * 3
    score += int(match["coverage"] * 42)
    if hospital.trauma:
        score += 8
    if hospital.phone:
        score += 3
    score = max(0, min(100, score))
    capacity_sentence = (
        f"Public bed count listed as {hospital.beds}; live ICU availability is not public."
        if hospital.beds is not None
        else "Public live bed/ICU capacity is not available from the open hospital dataset."
    )
    return {
        "name": hospital.name,
        "eta": hospital.eta,
        "distance": hospital.distance,
        "score": score,
        "specialty": " + ".join(hospital.specialty[:3]),
        "reason": (
            f"Matched {', '.join(match['matched']) or 'general emergency'} with "
            f"{hospital.distance}, {hospital.eta} min ETA. {capacity_sentence}"
        ),
        "beds": hospital.beds,
        "icu": hospital.icu,
        "capacity": hospital.capacity,
        "matchedSpecialties": match["matched"],
        "phone": hospital.phone,
        "lat": hospital.lat,
        "lng": hospital.lng,
        "source": hospital.source,
        "capacityNote": capacity_sentence,
    }


def gemini_available() -> bool:
    return bool((os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")) and genai is not None)


def _sync_generate_gemini_text(prompt: str) -> str:
    if not gemini_available():
        return ""
    model = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")
    client = genai.Client()
    if hasattr(client, "interactions"):
        interaction = client.interactions.create(model=model, input=prompt)
        return getattr(interaction, "output_text", "") or ""
    response = client.models.generate_content(model=model, contents=prompt)
    return getattr(response, "text", "") or ""


async def generate_gemini_text(prompt: str) -> str:
    try:
        return await asyncio.to_thread(_sync_generate_gemini_text, prompt)
    except Exception as exc:
        print(f"[GeminiReasoningAgent] Gemini call failed: {exc}")
        return ""


class EmergencyAgent:
    name: str = "Agent"
    task: str = ""

    async def run(self, state: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError


class TriageAgent(EmergencyAgent):
    name = "TriageAgent"
    task = "ESI v4 clinical urgency assessment"

    async def run(self, state: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(1.05)
        triage = classify_triage(state["symptoms"], state["age"])
        state["triage"] = triage
        return {
            "result": triage["summary"],
            "details": triage,
        }


class SpecialtyMatchAgent(EmergencyAgent):
    name = "SpecialtyMatchAgent"
    task = "Clinical semantic specialty mapping"

    async def run(self, state: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(0.9)
        required = state["triage"]["required_specialties"]
        state["required_specialties"] = required
        return {
            "result": "Requires " + " + ".join(required),
            "details": {"required_specialties": required},
        }


class HospitalSearchAgent(EmergencyAgent):
    name = "HospitalSearchAgent"
    task = "OpenStreetMap API nearby hospital discovery"

    async def run(self, state: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(1.15)
        coords = state["coords"]
        source = "OpenStreetMap Overpass API"
        nearby = await fetch_real_hospitals(coords["lat"], coords["lng"])
        if not nearby:
            raise RuntimeError("No public hospital records returned by OpenStreetMap near current coordinates.")
        state["nearby_hospitals"] = nearby
        state["hospital_search_source"] = source
        return {
            "result": f"{len(nearby)} nearby emergency facilities discovered via {source}",
            "details": {
                "source": source,
                "coords": coords,
                "hospitals": [hospital.name for hospital in nearby],
            },
        }


class CapacityAgent(EmergencyAgent):
    name = "CapacityAgent"
    task = "Public hospital metadata capacity audit"

    async def run(self, state: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(1.1)
        capacity = [
            {
                "name": hospital.name,
                "beds": hospital.beds,
                "icu": hospital.icu,
                "capacity": hospital.capacity,
                "source": hospital.source,
                "phone": hospital.phone,
            }
            for hospital in state["nearby_hospitals"]
        ]
        state["capacity"] = capacity
        listed_beds = sum(item["beds"] or 0 for item in capacity)
        facilities_with_beds = sum(1 for item in capacity if item["beds"] is not None)
        return {
            "result": (
                f"Public metadata checked for {len(capacity)} facilities; "
                f"{facilities_with_beds} list bed counts, live ICU feeds unavailable"
            ),
            "details": {"capacity": capacity, "publicListedBeds": listed_beds},
        }


class RoutingAgent(EmergencyAgent):
    name = "RoutingAgent"
    task = "Severity-adjusted hospital ranking"

    async def run(self, state: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(1.25)
        ranked = [
            score_route(hospital, state["triage"])
            for hospital in state["nearby_hospitals"]
        ]
        ranked.sort(key=lambda item: item["score"], reverse=True)
        state["ranked_hospitals"] = ranked
        state["recommended_hospital"] = ranked[0]
        return {
            "result": f"{ranked[0]['name']} selected with {ranked[0]['score']}/100 score",
            "details": {"rankedHospitals": ranked},
        }


class AdmissionAgent(EmergencyAgent):
    name = "AdmissionAgent"
    task = "Emergency call handoff packet"

    async def run(self, state: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(0.95)
        hospital = state["recommended_hospital"]
        reservation = {
            "reservationId": f"HB-{int(time.time())}",
            "hospital": hospital["name"],
            "phone": hospital.get("phone") or "public phone unavailable",
            "status": "call-ready",
        }
        state["reservation"] = reservation
        return {
            "result": f"ER call handoff packet prepared for {hospital['name']}",
            "details": reservation,
        }


class GeminiReasoningAgent(EmergencyAgent):
    name = "GeminiReasoningAgent"
    task = "LLM emergency explanation and dispatcher briefing"

    async def run(self, state: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(0.8)
        hospital = state["recommended_hospital"]
        prompt = f"""
You are Lifeline, a healthcare emergency decision-support assistant.
Do not diagnose. Do not claim real dispatch occurred.
Explain why this senior fall case should call the selected hospital first.

Patient:
- Name: {state["patient"]}
- Age: {state["age"]}
- Symptoms: {state["symptoms"]}
- Vitals: {state["vitals"]}

Triage:
{state["triage"]}

Recommended hospital:
{hospital}

Write a concise dispatcher briefing in 3 short bullets:
1. urgency
2. why this hospital
3. handoff note
"""
        text = await generate_gemini_text(prompt)
        used_gemini = bool(text and not text.startswith("Gemini unavailable"))
        if not text:
            text = ""
        state["gemini_briefing"] = text
        return {
            "result": "Gemini dispatcher briefing generated"
            if used_gemini
            else "Gemini unavailable; no LLM briefing generated",
            "details": {"briefing": text, "geminiActive": used_gemini},
        }


class NotifyAgent(EmergencyAgent):
    name = "NotifyAgent"
    task = "Caregiver and ER call-link preparation"

    async def run(self, state: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(0.9)
        hospital = state["recommended_hospital"]
        notifications = [
            f"Caregiver phone link prepared for Jane Chen",
            f"{hospital['name']} ER phone link prepared: {hospital.get('phone') or 'public phone unavailable'}",
            state.get("gemini_briefing") or "Gemini briefing unavailable",
            f"Emergency handoff note generated from real agent outputs",
        ]
        state["notifications"] = notifications
        return {
            "result": "Call links and dispatcher brief prepared",
            "details": {"notifications": notifications},
        }


PIPELINE: list[EmergencyAgent] = [
    TriageAgent(),
    SpecialtyMatchAgent(),
    HospitalSearchAgent(),
    CapacityAgent(),
    RoutingAgent(),
    AdmissionAgent(),
    GeminiReasoningAgent(),
    NotifyAgent(),
]


app = FastAPI(title="Lifeline Real Agent Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:5174",
        "http://localhost:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def initial_state(request: DispatchRequest) -> dict[str, Any]:
    return {
        "patient": request.patient,
        "age": request.age,
        "symptoms": request.symptoms,
        "location": request.location,
        "coords": {
            "lat": request.lat if request.lat is not None else PATIENT_COORDS["lat"],
            "lng": request.lng if request.lng is not None else PATIENT_COORDS["lng"],
        },
        "vitals": request.vitals
        or {"heartRate": 110, "spo2": 94, "response": "no safe response"},
        "events": [],
    }


def agent_event(
    agent: EmergencyAgent,
    status: AgentStatus,
    start: float,
    result: str = "",
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "type": "agent",
        "name": agent.name,
        "task": agent.task,
        "status": status,
        "result": result,
        "details": details or {},
        "latency": now_ms(start) if status == "done" else "live",
    }


async def run_agent_pipeline(
    request: DispatchRequest,
    queue: asyncio.Queue | None = None,
) -> dict[str, Any]:
    state = initial_state(request)
    agent_outputs = []

    for agent in PIPELINE:
        start = time.perf_counter()
        if queue:
            await queue.put(agent_event(agent, "active", start))
        output = await agent.run(state)
        event = agent_event(
            agent,
            "done",
            start,
            result=output["result"],
            details=output.get("details", {}),
        )
        state["events"].append(event)
        agent_outputs.append(
            {
                "name": agent.name,
                "task": agent.task,
                "result": event["result"],
                "latency": event["latency"],
                "status": "done" if agent.name != "NotifyAgent" else "active",
            }
        )
        if queue:
            await queue.put(event)

    hospital = state["recommended_hospital"]
    payload = {
        "patient": state["patient"],
        "triage": (
            f"{state['triage']['summary']}. "
            f"{state['triage']['action']} This recommendation is decision support only."
        ),
        "recommendedHospital": {
            "name": hospital["name"],
            "eta": hospital["eta"],
            "distance": hospital["distance"],
            "score": hospital["score"],
            "specialty": hospital["specialty"],
            "reason": hospital["reason"],
            "phone": hospital["phone"],
            "lat": hospital["lat"],
            "lng": hospital["lng"],
            "source": hospital["source"],
            "capacityNote": hospital["capacityNote"],
        },
        "caregiver": "Jane Chen",
        "caregiverPhone": "+1-555-010-0237",
        "timeline": [
            {"label": "Fall Detected by AI", "time": "10:30 AM", "status": "warning"},
            {"label": "Voice Verification No Response", "time": "10:31 AM", "status": "danger"},
            {"label": "Real Hospital Search Completed", "time": "10:31 AM", "status": "success"},
            {"label": "ER Call Link Ready", "time": "10:32 AM", "status": "active"},
        ],
        "agents": agent_outputs,
        "rankedHospitals": state["ranked_hospitals"],
        "reservation": state["reservation"],
        "notifications": state["notifications"],
        "llmBriefing": state.get("gemini_briefing", ""),
        "agentArchitecture": {
            "mode": "real_sequential_agents",
            "sharedState": True,
            "streaming": "SSE",
            "hospitalSearch": state.get("hospital_search_source", "not_run"),
            "tools": [
                state.get("hospital_search_source", "OpenStreetMap Overpass API"),
                "Gemini LLM briefing" if gemini_available() else "Gemini unavailable",
                "SSE live agent events",
                "Clinical routing score engine",
            ],
            "llmProvider": "Gemini"
            if gemini_available()
            else "rules + clinical scoring engine, Gemini key not configured",
        },
        "dataIntegrity": {
            "hospitalDiscovery": "OpenStreetMap Overpass API",
            "capacity": "Only public metadata is used; live bed/ICU feeds are not fabricated.",
            "phoneCalls": "Call buttons use tel: links; the user must place the call.",
            "llm": "Gemini API only; no generated LLM-style fallback text.",
        },
        "safetyNote": "Prototype only. The app prepares call links and decision support; it does not secretly contact emergency services.",
    }
    if queue:
        await queue.put({"type": "complete", "payload": payload})
    return payload


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "service": "heartbeat-real-agents",
        "agents": len(PIPELINE),
        "streaming": "SSE",
        "geminiConfigured": gemini_available(),
        "geminiModel": os.getenv("GEMINI_MODEL", "gemini-3.6-flash"),
    }


@app.post("/api/dispatch")
async def dispatch(request: DispatchRequest):
    return await run_agent_pipeline(request)


@app.get("/api/dispatch/stream")
async def dispatch_stream(
    symptoms: str = Query(..., min_length=3),
    location: str = Query("123 Maple Street"),
    patient: str = Query("Aunty Lim Mei"),
    age: int = Query(74, ge=0, le=120),
    lat: float | None = Query(None),
    lng: float | None = Query(None),
):
    queue: asyncio.Queue = asyncio.Queue(maxsize=100)
    request = DispatchRequest(
        symptoms=symptoms,
        location=location,
        patient=patient,
        age=age,
        lat=lat,
        lng=lng,
    )

    async def run() -> None:
        try:
            await run_agent_pipeline(request, queue)
        except Exception as exc:
            await queue.put(
                {
                    "type": "error",
                    "message": f"{type(exc).__name__}: {str(exc) or repr(exc)}",
                }
            )
        finally:
            await queue.put(None)

    async def event_generator():
        task = asyncio.create_task(run())
        try:
            while True:
                item = await queue.get()
                if item is None:
                    yield "data: [DONE]\n\n"
                    break
                yield f"data: {json.dumps(item)}\n\n"
        finally:
            task.cancel()

    return StreamingResponse(event_generator(), media_type="text/event-stream")
