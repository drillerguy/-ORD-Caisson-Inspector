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
  `;
  document.head.appendChild(style);
}

const DEFAULT_RECORD = {status:"No information",verified:false,notes:"",lat:null,lon:null,condition:"",updated:"",photos:[]};

globalThis.record = function(n){
  const current = records[n];
  return current ? {...DEFAULT_RECORD, ...current, photos:[...(current.photos||[])]} : {...DEFAULT_RECORD};
};

globalThis.saveRecords = function(){
  localStorage.setItem("ordCaissonRecords", JSON.stringify(records));
  renderPins();
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
    console.warn("Unable to read photo metadata", err);
  }
  return {capturedAt:fallbackDate, gps:null};
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
  const input = $("photos");
  const files = input ? [...input.files] : [];
  if(!files.length) return;
  const db = await dbPromise;
  const tx = db.transaction("photos", "readwrite");
  const store = tx.objectStore("photos");
  const current = record(n);
  let gpsToApply = null;

  for(const file of files){
    const uniqueId = globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const id = `${n}-${uniqueId}`;
    const metadata = await readPhotoMetadata(file);
    if(!gpsToApply && metadata.gps) gpsToApply = metadata.gps;
    store.put({
      id,
      caisson:n,
      name:file.name,
      type:file.type,
      blob:file,
      dateAdded:new Date().toISOString(),
      metadata
    });
    current.photos.push(id);
  }

  if(gpsToApply && (current.lat == null || current.lon == null)){
    current.lat = gpsToApply.lat;
    current.lon = gpsToApply.lon;
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
  </div>
  <div class="card">
    <h2 style="font-size:17px">Photos</h2>
    <input id="photos" type="file" accept="image/*" multiple>
    <p class="tiny" style="margin:8px 0 0">Photos save immediately after you take or select them.</p>
    <div id="photoGrid" class="photo-grid" style="margin-top:10px"></div>
    <p class="tiny">Photos are stored locally on this device in the browser.</p>
  </div>`;

  $("save").onclick = () => {
    const current = record(n);
    records[n] = {
      ...current,
      status:$("status").value,
      lat:numOrNull($("lat").value),
      lon:numOrNull($("lon").value),
      condition:$("condition").value,
      notes:$("notes").value,
      verified:$("verified").checked,
      updated:new Date().toISOString(),
      photos:[...(current.photos||[])]
    };
    saveRecords();
    selectCaisson(n);
  };

  $("photos").addEventListener("change", () => addPhotos(n));
  await showPhotos(n);

  const latest = record(n);
  if(latest.lat != null) $("lat").value = latest.lat;
  if(latest.lon != null) $("lon").value = latest.lon;

  const spot = HOTSPOTS.find(x=>x.caisson===n);
  if(spot){
    const shell = $("mapShell"), map = $("map");
    shell.scrollTo({left:map.offsetWidth*spot.x/100-shell.clientWidth/2,top:map.offsetHeight*spot.y/100-shell.clientHeight/2,behavior:"smooth"});
  }
};

renderPins();
