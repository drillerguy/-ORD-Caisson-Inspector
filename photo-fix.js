const PHOTO_STYLE_ID = "photo-fix-styles";
if (!document.getElementById(PHOTO_STYLE_ID)) {
  const style = document.createElement("style");
  style.id = PHOTO_STYLE_ID;
  style.textContent = `
    .photo-card{border:1px solid #d7dee7;border-radius:12px;padding:8px;background:#f8fafc}
    .photo-card img{width:100%;height:110px;object-fit:cover;border-radius:8px;display:block}
    .photo-meta{margin-top:8px;font-size:12px;color:#4e5965;line-height:1.35;word-break:break-word}
    .photo-meta strong{color:#16202a}
    .photo-delete{margin-top:8px;width:100%;background:#c32727}
    .tracking-bar{margin-top:10px;display:flex;gap:8px;align-items:stretch;flex-wrap:wrap}
    .tracking-toggle.on{background:#16803d}
    .tracking-status{flex:1;min-width:220px;background:#ffffff1a;border:1px solid #ffffff2f;border-radius:10px;padding:9px 11px;font-size:12px;line-height:1.4;color:white}
    .tracking-status strong{display:block;font-size:13px}
    .tracking-status .warning{color:#ffe28b}
    .tracking-status .muted{opacity:.82}
    .live-location-marker{position:absolute;transform:translate(-50%,-50%);pointer-events:none;z-index:6}
    .live-location-dot{position:relative;width:18px;height:18px;border-radius:50%;background:#1487ff;border:3px solid #fff;box-shadow:0 0 0 2px #1487ff66,0 1px 5px #0006}
    .live-location-dot::after{content:"";position:absolute;inset:-7px;border-radius:50%;border:2px solid #1487ff66}
    .live-location-accuracy{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border-radius:50%;background:#1487ff26;border:1px solid #1487ff55;min-width:18px;min-height:18px}
    .tracking-note{margin-top:8px;font-size:12px;color:#6b7580;line-height:1.35}
    @media(max-width:760px){
      .tracking-bar{display:block}
      .tracking-toggle{width:100%}
      .tracking-status{margin-top:8px;min-width:0}
    }
  `;
  document.head.appendChild(style);
}

const DEFAULT_RECORD = {status:"No information",verified:false,notes:"",lat:null,lon:null,condition:"",updated:"",photos:[]};
const pendingPhotoAdds = new Map();
const TRACKING_ACCURACY_WARNING_METERS = 9; // Warn when GPS drift is about 30 ft, which can put the marker on the wrong caisson.
const TRACKING_CONTROL_ID = "trackingBar";
const EARTH_RADIUS_METERS = 6378137;

const trackingState = {
  watchId:null,
  current:null,
  lastError:"",
  isStarting:false,
  hasCentered:false
};

let geoReference = null;
let averageMetersPerPercent = 0;

refreshGeoReference();
ensureTrackingControls();

globalThis.record = function(n){
  const current = records[n];
  return current ? {...DEFAULT_RECORD, ...current, photos:[...(current.photos||[])]} : {...DEFAULT_RECORD};
};

globalThis.saveRecords = function(){
  localStorage.setItem("ordCaissonRecords", JSON.stringify(records));
  refreshGeoReference();
  renderPins();
  syncTrackingOverlay();
};

function formatStoredDate(value){
  if(!value) return "";
  if(/^\d{4}:\d{2}:\d{2} /.test(value)) return value.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

function formatCoordinate(value){
  return Number.isFinite(value) ? value.toFixed(6) : "";
}

function formatDistance(meters){
  if(!Number.isFinite(meters)) return "";
  const feet = meters * 3.28084;
  if(feet < 1000) return `${Math.round(feet)} ft`;
  return `${(meters / 1609.344).toFixed(2)} mi`;
}

function describeMetadata(photo){
  const parts = [`<div><strong>${esc(photo.name||"Photo")}</strong></div>`];
  const taken = photo.metadata?.capturedAt || photo.capturedAt;
  const gps = photo.metadata?.gps || photo.gps;
  const added = photo.dateAdded || photo.date;
  parts.push(`<div>Taken: ${esc(taken ? formatStoredDate(taken) : "Not available")}</div>`);
  parts.push(`<div>GPS: ${gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lon) ? `${formatCoordinate(gps.lat)}, ${formatCoordinate(gps.lon)}` : "Not available"}</div>`);
  if(added) parts.push(`<div>Saved: ${esc(formatStoredDate(added))}</div>`);
  return parts.join("");
}

function readCurrentFormValues(){
  return {
    status:$("status")?.value ?? "No information",
    lat:numOrNull($("lat")?.value ?? ""),
    lon:numOrNull($("lon")?.value ?? ""),
    condition:$("condition")?.value ?? "",
    notes:$("notes")?.value ?? "",
    verified:Boolean($("verified")?.checked)
  };
}

function ensureTrackingControls(){
  const header = document.querySelector("header");
  if(!header || document.getElementById(TRACKING_CONTROL_ID)) return;
  const bar = document.createElement("div");
  bar.id = TRACKING_CONTROL_ID;
  bar.className = "tracking-bar";
  bar.innerHTML = `
    <button id="trackToggle" class="tracking-toggle secondary" type="button">Start Live GPS</button>
    <div id="trackingStatus" class="tracking-status">
      <strong>Live GPS is off</strong>
      <div class="muted">Turn it on to follow your location on the drawing and see the nearest caisson.</div>
    </div>`;
  header.appendChild(bar);
  $("trackToggle")?.addEventListener("click", toggleTracking);
}

function applyGpsToInputs(gps){
  if(!gps || !Number.isFinite(gps.lat) || !Number.isFinite(gps.lon)) return;
  const latInput = $("lat");
  const lonInput = $("lon");
  if(latInput && !latInput.value) latInput.value = String(gps.lat);
  if(lonInput && !lonInput.value) lonInput.value = String(gps.lon);
}

function getTrackedGps(){
  const current = trackingState.current;
  if(!current) return null;
  const ageMs = Date.now() - current.timestamp;
  return ageMs <= 120000 ? {lat:current.lat, lon:current.lon, accuracy:current.accuracy} : null;
}

function getDeviceGps(){
  const tracked = getTrackedGps();
  if(tracked) return Promise.resolve(tracked);
  if(!navigator.geolocation?.getCurrentPosition) return Promise.resolve(null);
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      ({coords}) => {
        if(Number.isFinite(coords?.latitude) && Number.isFinite(coords?.longitude)){
          resolve({lat:coords.latitude, lon:coords.longitude, accuracy:Number.isFinite(coords?.accuracy) ? coords.accuracy : null});
        }else{
          resolve(null);
        }
      },
      () => resolve(null),
      {enableHighAccuracy:true, timeout:10000, maximumAge:120000}
    );
  });
}

function createPhotoId(n){
  const generatedId = globalThis.crypto?.randomUUID?.();
  if(generatedId) return `${n}-${generatedId}`;
  const bytes = new Uint8Array(16);
  if(globalThis.crypto?.getRandomValues){
    globalThis.crypto.getRandomValues(bytes);
    return `${n}-${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  throw new Error("Unable to generate photo ID: this browser does not support the required security features. Please update your browser.");
}

function exifDateToIso(value){
  if(!value || typeof value !== "string") return null;
  const match = value.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}` : null;
}

function rationalToNumber(entry){
  return entry && entry.denominator ? entry.numerator / entry.denominator : NaN;
}

function dmsToDecimal(values, ref){
  if(!Array.isArray(values) || values.length < 3) return null;
  const degrees = rationalToNumber(values[0]);
  const minutes = rationalToNumber(values[1]);
  const seconds = rationalToNumber(values[2]);
  if([degrees, minutes, seconds].some(v=>!Number.isFinite(v))) return null;
  let decimal = degrees + minutes / 60 + seconds / 3600;
  if(ref === "S" || ref === "W") decimal *= -1;
  return decimal;
}

function makeTiffReader(view, start, littleEndian){
  return {
    getShort(offset){ return view.getUint16(start + offset, littleEndian); },
    getLong(offset){ return view.getUint32(start + offset, littleEndian); },
    getAscii(offset, count){
      let out = "";
      for(let i=0;i<count;i++){
        const code = view.getUint8(start + offset + i);
        if(code === 0) break;
        out += String.fromCharCode(code);
      }
      return out;
    },
    getRational(offset){
      return {numerator:view.getUint32(start + offset, littleEndian), denominator:view.getUint32(start + offset + 4, littleEndian)};
    }
  };
}

function readIfdEntry(reader, entryOffset){
  return {
    tag: reader.getShort(entryOffset),
    type: reader.getShort(entryOffset + 2),
    count: reader.getLong(entryOffset + 4),
    valueOffset: reader.getLong(entryOffset + 8),
    valueFieldOffset: entryOffset + 8
  };
}

function readTagValue(reader, entry){
  const {type, count, valueOffset, valueFieldOffset} = entry;
  if(type === 2) return reader.getAscii(count <= 4 ? valueFieldOffset : valueOffset, count);
  if(type === 5){
    if(count === 1) return reader.getRational(valueOffset);
    return Array.from({length:count}, (_,i)=>reader.getRational(valueOffset + i * 8));
  }
  return valueOffset;
}

async function readPhotoMetadata(file){
  const fallbackDate = file.lastModified ? new Date(file.lastModified).toISOString() : null;
  if(!file.type || !file.type.toLowerCase().includes("jpeg")) return {capturedAt:fallbackDate, gps:null};
  try{
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);
    if(view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return {capturedAt:fallbackDate, gps:null};
    let offset = 2;
    while(offset + 4 <= view.byteLength){
      const marker = view.getUint16(offset);
      const size = view.getUint16(offset + 2);
      if(marker === 0xFFE1 && size >= 10 && offset + 2 + size <= view.byteLength){
        const exifHeader = String.fromCharCode(
          view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7)
        );
        if(exifHeader !== "Exif") {
          offset += 2 + size;
          continue;
        }
        const tiffStart = offset + 10;
        const littleEndian = view.getUint16(tiffStart) === 0x4949;
        const reader = makeTiffReader(view, tiffStart, littleEndian);
        const firstIfd = reader.getLong(4);
        let capturedAt = null;
        let gps = null;

        const parseIfd = (relativeOffset) => {
          const count = reader.getShort(relativeOffset);
          const entries = [];
          for(let i=0;i<count;i++) entries.push(readIfdEntry(reader, relativeOffset + 2 + i * 12));
          return entries;
        };

        const rootEntries = parseIfd(firstIfd);
        let exifIfdPointer = null;
        let gpsIfdPointer = null;
        for(const entry of rootEntries){
          if(entry.tag === 0x8769) exifIfdPointer = entry.valueOffset;
          if(entry.tag === 0x8825) gpsIfdPointer = entry.valueOffset;
          if(entry.tag === 0x0132 && !capturedAt) capturedAt = exifDateToIso(readTagValue(reader, entry));
        }
        if(exifIfdPointer){
          for(const entry of parseIfd(exifIfdPointer)){
            if(entry.tag === 0x9003 && !capturedAt) capturedAt = exifDateToIso(readTagValue(reader, entry));
            if(entry.tag === 0x9004 && !capturedAt) capturedAt = exifDateToIso(readTagValue(reader, entry));
          }
        }
        if(gpsIfdPointer){
          let latRef = null, lonRef = null, lat = null, lon = null;
          for(const entry of parseIfd(gpsIfdPointer)){
            if(entry.tag === 1) latRef = readTagValue(reader, entry);
            if(entry.tag === 2) lat = readTagValue(reader, entry);
            if(entry.tag === 3) lonRef = readTagValue(reader, entry);
            if(entry.tag === 4) lon = readTagValue(reader, entry);
          }
          const parsedLat = dmsToDecimal(lat, latRef);
          const parsedLon = dmsToDecimal(lon, lonRef);
          if(Number.isFinite(parsedLat) && Number.isFinite(parsedLon)) gps = {lat:parsedLat, lon:parsedLon};
        }
        return {capturedAt:capturedAt || fallbackDate, gps};
      }
      if(marker === 0xFFDA || size < 2) break;
      offset += 2 + size;
    }
  }catch(err){
    console.warn("Unable to extract EXIF metadata from photo. The photo will still be saved, but automatic GPS coordinates and capture time will not be available.", err);
  }
  return {capturedAt:fallbackDate, gps:null};
}

function toRadians(value){
  return value * Math.PI / 180;
}

function projectGps(gps, origin){
  const cosLat = Math.cos(toRadians(origin.lat));
  return {
    x:(gps.lon - origin.lon) * toRadians(1) * EARTH_RADIUS_METERS * cosLat,
    y:(gps.lat - origin.lat) * toRadians(1) * EARTH_RADIUS_METERS
  };
}

function unprojectPoint(point, origin){
  const cosLat = Math.cos(toRadians(origin.lat));
  return {
    lat:origin.lat + (point.y / EARTH_RADIUS_METERS) / toRadians(1),
    lon:origin.lon + (point.x / (EARTH_RADIUS_METERS * cosLat)) / toRadians(1)
  };
}

function buildAverageMetersPerPercent(){
  if(!geoReference?.controlPoints?.length) return 0;
  const samples = [];
  const controls = geoReference.controlPoints;
  for(let i=0;i<controls.length;i++){
    for(let j=i+1;j<controls.length;j++){
      const deltaPercent = Math.hypot(controls[i].targetX - controls[j].targetX, controls[i].targetY - controls[j].targetY);
      const deltaMeters = haversineDistance(controls[i].gps, controls[j].gps);
      if(deltaPercent > 0 && Number.isFinite(deltaMeters)) samples.push(deltaMeters / deltaPercent);
    }
  }
  if(!samples.length) return 0;
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

function refreshGeoReference(){
  geoReference = buildGeoReference();
  averageMetersPerPercent = buildAverageMetersPerPercent();
}

function buildGeoReference(){
  const controlPoints = HOTSPOTS
    .map(spot => ({spot, record:record(spot.caisson)}))
    .filter(({record}) => record.verified && Number.isFinite(record.lat) && Number.isFinite(record.lon));
  if(controlPoints.length < 3) return null;
  const origin = controlPoints.reduce((acc, {record}) => ({lat:acc.lat + record.lat, lon:acc.lon + record.lon}), {lat:0, lon:0});
  origin.lat /= controlPoints.length;
  origin.lon /= controlPoints.length;
  return {
    origin,
    controlPoints:controlPoints.map(({spot, record}) => {
      const projected = projectGps(record, origin);
      return {
        caisson:spot.caisson,
        gps:{lat:record.lat, lon:record.lon},
        sourceX:projected.x,
        sourceY:projected.y,
        targetX:spot.x,
        targetY:spot.y
      };
    })
  };
}

function gpsToMapPosition(gps){
  if(!geoReference || !gps) return null;
  const projected = projectGps(gps, geoReference.origin);
  const ranked = geoReference.controlPoints
    .map(point => ({...point, distance:Math.hypot(projected.x - point.sourceX, projected.y - point.sourceY)}))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.min(6, geoReference.controlPoints.length));
  if(!ranked.length) return null;
  if(ranked[0].distance < 0.01) return {x:ranked[0].targetX, y:ranked[0].targetY};
  let totalWeight = 0;
  let weightedX = 0;
  let weightedY = 0;
  for(const point of ranked){
    const weight = 1 / Math.max(point.distance, 1) ** 2; // Keep very close control points from overwhelming the interpolation.
    totalWeight += weight;
    weightedX += point.targetX * weight;
    weightedY += point.targetY * weight;
  }
  if(!totalWeight) return null;
  return {x:weightedX / totalWeight, y:weightedY / totalWeight};
}

function haversineDistance(a, b){
  if(!a || !b) return Infinity;
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const calc = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(calc)));
}

function getNearestCaisson(gps){
  const position = gpsToMapPosition(gps);
  if(!position) return null;
  let best = null;
  for(const spot of HOTSPOTS){
    const distancePercent = Math.hypot(position.x - spot.x, position.y - spot.y);
    const distance = averageMetersPerPercent > 0 ? distancePercent * averageMetersPerPercent : distancePercent;
    if(!best || distance < best.distance){
      best = {caisson:spot.caisson, distance, spot, position};
    }
  }
  return best;
}

function getAccuracyMeters(){
  return Number.isFinite(trackingState.current?.accuracy) ? trackingState.current.accuracy : null;
}

function getAccuracyStatusClass(){
  const accuracy = getAccuracyMeters();
  return accuracy && accuracy > TRACKING_ACCURACY_WARNING_METERS ? "warning" : "muted";
}

function describeTrackingStatus(){
  if(!geoReference) return {
    title:"Live GPS unavailable",
    detail:"Not enough verified caisson GPS points are available to align the drawing.",
    warning:""
  };
  if(trackingState.lastError) return {
    title:"Live GPS unavailable",
    detail:trackingState.lastError,
    warning:"Enable location permissions in your device settings and browser."
  };
  if(trackingState.watchId === null){
    return {
      title:"Live GPS is off",
      detail:"Turn it on to follow your location on the drawing and see the nearest caisson.",
      warning:""
    };
  }
  if(trackingState.isStarting || !trackingState.current){
    return {
      title:"Looking for GPS…",
      detail:"Stay outside or near the caissons until the phone reports your location.",
      warning:""
    };
  }
  const nearest = getNearestCaisson(trackingState.current);
  const accuracy = getAccuracyMeters();
  const accuracyText = accuracy ? `GPS accuracy ±${formatDistance(accuracy)}` : "GPS accuracy unavailable";
  return {
    title:nearest ? `Nearest caisson ${nearest.caisson}` : "Live GPS running",
    detail:nearest ? `${formatDistance(nearest.distance)} away • ${accuracyText}` : accuracyText,
    warning:accuracy && accuracy > TRACKING_ACCURACY_WARNING_METERS ? "Accuracy is loose right now, so use the nearest-caisson number as a guide only." : ""
  };
}

function updateTrackingUi(){
  const button = $("trackToggle");
  const status = $("trackingStatus");
  const state = describeTrackingStatus();
  if(button){
    const isOn = trackingState.watchId !== null || trackingState.isStarting;
    button.textContent = isOn ? "Stop Live GPS" : "Start Live GPS";
    button.classList.toggle("on", isOn);
    button.classList.toggle("secondary", !isOn);
    button.disabled = !geoReference;
  }
  if(status){
    status.innerHTML = `<strong>${esc(state.title)}</strong><div>${esc(state.detail)}</div>${state.warning ? `<div class="${getAccuracyStatusClass()}">${esc(state.warning)}</div>` : ""}`;
  }
}

function ensureTrackingMarker(){
  const pins = $("pins");
  if(!pins) return null;
  let marker = $("liveLocationMarker");
  if(marker) return marker;
  marker = document.createElement("div");
  marker.id = "liveLocationMarker";
  marker.className = "live-location-marker";
  marker.hidden = true;
  marker.innerHTML = '<div class="live-location-accuracy" id="liveLocationAccuracy"></div><div class="live-location-dot"></div>';
  pins.appendChild(marker);
  return marker;
}

function centerMapOnPosition(position){
  const shell = $("mapShell");
  const map = $("map");
  if(!shell || !map || !position) return;
  const left = map.offsetWidth * position.x / 100 - shell.clientWidth / 2;
  const top = map.offsetHeight * position.y / 100 - shell.clientHeight / 2;
  shell.scrollTo({left, top, behavior:trackingState.hasCentered ? "smooth" : "auto"});
  trackingState.hasCentered = true;
}

function syncTrackingOverlay(){
  updateTrackingUi();
  const marker = ensureTrackingMarker();
  if(!marker || !trackingState.current || !geoReference){
    if(marker) marker.hidden = true;
    return;
  }
  const position = gpsToMapPosition(trackingState.current);
  if(!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)){
    marker.hidden = true;
    return;
  }
  marker.hidden = false;
  marker.style.left = `${position.x}%`;
  marker.style.top = `${position.y}%`;
  const map = $("map");
  const accuracyRing = $("liveLocationAccuracy");
  if(map && accuracyRing && Number.isFinite(trackingState.current.accuracy)){
    const nearest = getNearestCaisson(trackingState.current);
    const distanceForOpacity = nearest?.distance ?? trackingState.current.accuracy;
    const percentRadius = averageMetersPerPercent > 0 ? trackingState.current.accuracy / averageMetersPerPercent : 0.4; // Fall back to a small visible ring when scale cannot be estimated.
    accuracyRing.style.width = `${Math.max(18, map.offsetWidth * percentRadius / 100 * 2)}px`;
    accuracyRing.style.height = `${Math.max(18, map.offsetWidth * percentRadius / 100 * 2)}px`;
    accuracyRing.style.opacity = distanceForOpacity > TRACKING_ACCURACY_WARNING_METERS ? "0.85" : "1";
  }
  centerMapOnPosition(position);
}

function startTracking(){
  if(!geoReference){
    updateTrackingUi();
    return;
  }
  if(trackingState.watchId !== null || trackingState.isStarting) return;
  if(!navigator.geolocation?.watchPosition){
    trackingState.lastError = "This browser does not support live GPS tracking.";
    updateTrackingUi();
    return;
  }
  trackingState.lastError = "";
  trackingState.current = null;
  trackingState.isStarting = true;
  trackingState.hasCentered = false;
  updateTrackingUi();
  trackingState.watchId = navigator.geolocation.watchPosition(
    ({coords, timestamp}) => {
      trackingState.isStarting = false;
      trackingState.lastError = "";
      trackingState.current = {
        lat:coords.latitude,
        lon:coords.longitude,
        accuracy:Number.isFinite(coords.accuracy) ? coords.accuracy : null,
        timestamp:timestamp || Date.now()
      };
      syncTrackingOverlay();
    },
    error => {
      trackingState.isStarting = false;
      trackingState.lastError = error?.code === 1
        ? "Location permission was denied."
        : error?.code === 2
          ? "The phone could not get a GPS fix."
          : "Live GPS timed out. Try again outside or with a stronger signal.";
      stopTracking({preserveError:true});
    },
    {enableHighAccuracy:true, maximumAge:5000, timeout:15000}
  );
}

function stopTracking({preserveError=false} = {}){
  if(trackingState.watchId !== null && navigator.geolocation?.clearWatch) navigator.geolocation.clearWatch(trackingState.watchId);
  trackingState.watchId = null;
  trackingState.isStarting = false;
  trackingState.current = preserveError ? null : trackingState.current;
  trackingState.hasCentered = false;
  if(!preserveError) trackingState.lastError = "";
  const marker = $("liveLocationMarker");
  if(marker) marker.hidden = true;
  updateTrackingUi();
}

function toggleTracking(){
  if(trackingState.watchId !== null || trackingState.isStarting) stopTracking();
  else startTracking();
}

async function deletePhoto(n, id){
  const db = await dbPromise;
  const tx = db.transaction("photos", "readwrite");
  tx.objectStore("photos").delete(id);
  await new Promise((resolve, reject)=>{
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const current = record(n);
  current.photos = (current.photos || []).filter(photoId => photoId !== id);
  current.updated = new Date().toISOString();
  records[n] = current;
  saveRecords();
  if(selected === n) await selectCaisson(n);
}

globalThis.addPhotos = async function(n){
  const job = (async () => {
    const input = $("photos");
    const files = input ? [...input.files] : [];
    if(!files.length) return;
    const db = await dbPromise;
    const tx = db.transaction("photos", "readwrite");
    const store = tx.objectStore("photos");
    const current = record(n);
    const isLocationMissing = current.lat === null || current.lon === null;
    current.photos = [...(current.photos || [])];
    const fileEntries = await Promise.all(files.map(async file => ({file, metadata:await readPhotoMetadata(file)})));
    const firstEntryWithGps = fileEntries.find(({metadata}) => metadata.gps);
    let gpsToApply = firstEntryWithGps ? firstEntryWithGps.metadata.gps : null;
    const needsDeviceGps = isLocationMissing && !gpsToApply && fileEntries.some(({metadata}) => !metadata.gps);
    const fallbackGps = needsDeviceGps ? await getDeviceGps() : null;

    for(const {file, metadata} of fileEntries){
      const id = createPhotoId(n);
      const effectiveGps = metadata.gps || fallbackGps || null;
      if(!gpsToApply && effectiveGps) gpsToApply = effectiveGps;
      store.put({
        id,
        caisson:n,
        name:file.name,
        type:file.type,
        blob:file,
        dateAdded:new Date().toISOString(),
        metadata:{...metadata, gps:effectiveGps}
      });
      current.photos.push(id);
    }

    if(gpsToApply && isLocationMissing){
      current.lat = gpsToApply.lat;
      current.lon = gpsToApply.lon;
      applyGpsToInputs(gpsToApply);
    }
    current.updated = new Date().toISOString();
    records[n] = current;
    saveRecords();

    await new Promise((resolve, reject)=>{
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    if(input) input.value = "";
    if(selected === n) await selectCaisson(n);
  })();

  pendingPhotoAdds.set(n, job);
  try{
    await job;
  } finally {
    if(pendingPhotoAdds.get(n) === job) pendingPhotoAdds.delete(n);
  }
};

globalThis.showPhotos = async function(n){
  const grid = $("photoGrid");
  if(!grid) return;
  const ids = record(n).photos || [];
  if(!ids.length){
    grid.innerHTML = '<span class="tiny">No photos added.</span>';
    return;
  }
  const db = await dbPromise;
  const tx = db.transaction("photos");
  const store = tx.objectStore("photos");
  const photos = await Promise.all(ids.map(id => new Promise(resolve => {
    const q = store.get(id);
    q.onsuccess = () => resolve(q.result || null);
    q.onerror = () => resolve(null);
  })));

  grid.innerHTML = "";
  for(const photo of photos.filter(Boolean)){
    const card = document.createElement("div");
    card.className = "photo-card";

    const img = document.createElement("img");
    const url = URL.createObjectURL(photo.blob);
    img.src = url;
    img.alt = photo.name || "Caisson photo";
    img.onload = () => URL.revokeObjectURL(url);
    img.onerror = () => URL.revokeObjectURL(url);
    card.appendChild(img);

    const meta = document.createElement("div");
    meta.className = "photo-meta";
    meta.innerHTML = describeMetadata(photo);
    card.appendChild(meta);

    const button = document.createElement("button");
    button.className = "photo-delete";
    button.textContent = "Delete";
    button.onclick = () => deletePhoto(n, photo.id);
    card.appendChild(button);

    grid.appendChild(card);
  }
};

globalThis.selectCaisson = async function(n){
  selected = n;
  renderPins();
  syncTrackingOverlay();
  const r = record(n);
  $("panel").innerHTML = `
  <div class="card">
    <h2>Caisson ${n}</h2>
    <span class="badge ${r.verified?"green":"gray"}">${r.verified?"Verified location":"Not verified"}</span>
    <label class="label">Status</label><select id="status">
     ${["No information","Verified GPS","Needs review","Repair required","Accepted","Backfilled"].map(x=>`<option ${r.status===x?"selected":""}>${x}</option>`).join("")}
    </select>
    <div class="row">
     <div><label class="label">Latitude</label><input id="lat" type="number" step="any" value="${r.lat??""}"></div>
     <div><label class="label">Longitude</label><input id="lon" type="number" step="any" value="${r.lon??""}"></div>
    </div>
    <label class="label">Condition / work stage</label><input id="condition" value="${esc(r.condition||"")}" placeholder="Excavated, standing water, repair...">
    <label class="label">Notes</label><textarea id="notes" rows="4">${esc(r.notes||"")}</textarea>
    <label class="label"><input id="verified" type="checkbox" ${r.verified?"checked":""} style="width:auto"> GPS/location verified</label>
    <button id="save">Save Caisson Information</button>
    <p class="tracking-note">Live GPS can auto-fill a missing location when you add photos, and the pulsing blue position marker stays on the drawing while you move.</p>
  </div>
  <div class="card">
    <h2 style="font-size:17px">Photos</h2>
    <input id="photos" type="file" accept="image/*" capture="environment" multiple>
    <p class="tiny" style="margin:8px 0 0">Photos are stored locally after selection is confirmed.</p>
    <div id="photoGrid" class="photo-grid" style="margin-top:10px"></div>
    <p class="tiny">Photos are stored locally on this device in the browser.</p>
  </div>`;

  $("save").onclick = async () => {
    const formValues = readCurrentFormValues();
    try{
      await (pendingPhotoAdds.get(n) || Promise.resolve());
    }catch(err){
      console.error("Unable to finish saving photos", err);
      alert(`Unable to complete photo addition: ${err?.message || "Unknown error"}. Please try adding the photo again.`);
      return;
    }
    const current = record(n);
    records[n] = {
      ...current,
      status:formValues.status,
      lat:formValues.lat,
      lon:formValues.lon,
      condition:formValues.condition,
      notes:formValues.notes,
      verified:formValues.verified,
      updated:new Date().toISOString(),
      photos:[...(current.photos||[])]
    };
    saveRecords();
    selectCaisson(n);
  };

  $("photos").addEventListener("change", () => addPhotos(n));
  await showPhotos(n);
  const spot = HOTSPOTS.find(x=>x.caisson===n);
  if(spot && trackingState.watchId === null){
    const shell = $("mapShell"), map = $("map");
    shell.scrollTo({left:map.offsetWidth*spot.x/100-shell.clientWidth/2,top:map.offsetHeight*spot.y/100-shell.clientHeight/2,behavior:"smooth"});
  }
};

updateTrackingUi();
renderPins();
syncTrackingOverlay();
