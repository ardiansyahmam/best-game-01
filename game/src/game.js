// Gloamguard — arena-survival 3D: guard the prism lighthouse, 5 waves + boss.
// three.js r187 vendored locally; Polyfork GLBs local; no network at runtime.
// Live play uses wall-clock dt; ?shot=start|play|boss|end&seed=N runs a fixed
// 1/60-step deterministic simulation and raises window.__shotReady.

import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.min.js';
import { clone as cloneSkinned } from '../vendor/SkeletonUtils.min.js';
import { Sfx } from './audio.js';

const params = new URLSearchParams(location.search);
const SHOT = params.get('shot') || null;          // start | play | boss | end
const SEED = Number(params.get('seed') ?? '1');
const SHOT_MODE = SHOT !== null;
if (SHOT_MODE) document.documentElement.classList.add('shot');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED * 2654435761 + 7);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist2d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return Math.abs(d); };

// ---------- tuning ----------
const ARENA_R = 15;                 // playable radius
const BEAM_COUNT = 3;
const BEAM_HALF = THREE.MathUtils.degToRad(19); // half-width of a light wedge
const BEAM_PERIOD = 8;              // seconds per full rotation
const PAR_TIME = [45, 50, 55, 60, 90];
const WAVE_COMP = [                 // spawn lists per wave
  ['stalker', 'stalker', 'stalker', 'stalker', 'stalker'],
  ['stalker', 'stalker', 'stalker', 'stalker', 'stalker', 'shooter', 'shooter', 'shooter'],
  ['stalker', 'stalker', 'stalker', 'stalker', 'stalker', 'shooter', 'shooter', 'shooter', 'brute', 'brute'],
  ['stalker', 'stalker', 'stalker', 'stalker', 'stalker', 'stalker', 'stalker', 'stalker', 'shooter', 'shooter', 'shooter', 'shooter', 'brute', 'brute', 'brute'],
  ['boss'],
];
const ENEMY_DEF = {
  stalker: { hp: 60,  speed: 3.7, dmg: 12, score: 100, radius: 0.75, height: 1.85, color: 0xffffff },
  shooter: { hp: 45,  speed: 2.7, dmg: 8,  score: 100, radius: 0.75, height: 1.85, color: 0x7de8d8 },
  brute:   { hp: 230, speed: 1.7, dmg: 25, score: 250, radius: 1.05, height: 2.3,  color: 0xffffff },
  boss:    { hp: 1500, speed: 1.55, dmg: 30, score: 1500, radius: 1.9, height: 4.6, color: 0xffb060 },
};
const UPGRADES = [
  { id: 'twin',  ico: '✦', name: 'Twin Spark',   desc: 'Fire an extra Sunspike bolt with each shot.', max: 2 },
  { id: 'lens',  ico: '◎', name: 'Long Lens',    desc: '+35% bolt range and +15% bolt speed.', max: 3 },
  { id: 'heart', ico: '◆', name: 'Prism Heart',  desc: '+1 charge to the prism core.', max: 2 },
  { id: 'quick', ico: '≫', name: 'Quickstep',    desc: 'Dash recharges 30% faster.', max: 3 },
  { id: 'ember', ico: '🔥', name: 'Ember Loop',   desc: 'Embers heal twice as much and pull from farther.', max: 2 },
];

// ---------- dom ----------
const $ = (id) => document.getElementById(id);
const el = {
  hud: $('hud'), hpFill: $('hpfill'), hpText: $('hptext'), core: $('core'),
  waveText: $('wavetext'), waveTimer: $('wave-timer'), scoreText: $('scoretext'),
  emberText: $('embertext'), bestText: $('besttext'), qFill: $('qfill'), dashFill: $('dashfill'),
  banner: $('banner'), bannerTitle: $('banner-title'), bannerSub: $('banner-sub'),
  dmg: $('dmg'), title: $('title'), upgrade: $('upgrade'), upgTimer: $('upgtimer'),
  cards: $('cards'), pause: $('pause'), endcard: $('endcard'), endTitle: $('end-title'),
  endSub: $('end-sub'), endScore: $('end-score'), endWave: $('end-wave'), endBest: $('end-best'),
  coreFlash: $('coreflash'), corePanel: $('corepanel'), shakeBtn: $('shake-btn'),
};

// ---------- state ----------
const BEST_KEY = 'gloamguard_best';
const G = {
  state: 'title',           // title | playing | upgrade | paused | victory | defeat
  wave: 1, score: 0, embers: 0, best: Number(localStorage.getItem(BEST_KEY) || 0),
  core: 5, coreMax: 5, waveTime: 0, spawnQueue: [], spawnTimer: 0,
  beamAngle: 0, beamTarget: 0, qCd: 0, time: 0, shake: 0, hitStop: 0,
  enemies: [], bolts: [], ebolts: [], particles: [], dmgNums: [], pickups: [],
  boss: null, bossAddsTimer: 0, bossMotifTimer: 0, bossSlam: null, bossCharge: null,
  upgradeChoices: [], upgradeTimer: 0, bannerTimer: 0,
  shakeOn: true, // camera-shake toggle (pause menu); persisted in localStorage
  upg: { twin: 0, lens: 0, heart: 0, quick: 0, ember: 0 },
  pausedFrom: null,
};
const player = {
  pos: new THREE.Vector3(0, 0, 6), vel: new THREE.Vector3(), aim: new THREE.Vector3(0, 0, -1),
  hp: 100, hpMax: 100, speed: 7, fireCd: 0, dashCd: 0, dashTime: 0, dashDir: new THREE.Vector3(),
  invuln: 0, moving: false, mixer: null, obj: null, radius: 0.7,
  flinchT: 0, flinchDir: new THREE.Vector3(0, 0, 1), // hit reaction (user feedback)
};
const keys = {};
let mouseNDC = new THREE.Vector2(0, 0);
let mouseDown = false;
let botAim = null; // shot-mode scripted aim (Vector3) — null in live play
let botHold = false; // shot-mode: stand still and fire (stable framing)
let botFire = true;  // shot-mode: allow the bot to shoot (off = let hit-flash expire)

const sfx = new Sfx();

// ---------- renderer / scene ----------
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x171310);
scene.fog = new THREE.Fog(0x171310, 26, 62);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 13, 12);

scene.add(new THREE.HemisphereLight(0xffe8c0, 0x2a2018, 1.25));
const sun = new THREE.DirectionalLight(0xffd9a0, 2.1);
sun.position.set(10, 18, 6);
scene.add(sun);
const towerLight = new THREE.PointLight(0xffa040, 90, 34, 1.8);
towerLight.position.set(0, 4.5, 0);
scene.add(towerLight);

// ---------- arena (procedural, few draw calls) ----------
function floorTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#2b2620'; g.fillRect(0, 0, 1024, 1024);
  const cx = 512, cy = 512;
  // stone tiles: concentric rings + radial seams
  for (let r = 100; r <= 512; r += 64) {
    g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = 5;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  }
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * 96, cy + Math.sin(a) * 96);
    g.lineTo(cx + Math.cos(a) * 512, cy + Math.sin(a) * 512); g.stroke();
  }
  // speckles + amber sand patches
  for (let i = 0; i < 2600; i++) {
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 505;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    g.fillStyle = rand() < 0.5 ? 'rgba(255,200,120,0.05)' : 'rgba(0,0,0,0.16)';
    g.fillRect(x, y, 2 + rand() * 4, 2 + rand() * 4);
  }
  for (let i = 0; i < 26; i++) {
    const a = rand() * Math.PI * 2, r = 90 + rand() * 400;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r, rr = 18 + rand() * 46;
    const grad = g.createRadialGradient(x, y, 0, x, y, rr);
    grad.addColorStop(0, 'rgba(214,164,90,0.16)'); grad.addColorStop(1, 'rgba(214,164,90,0)');
    g.fillStyle = grad; g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(ARENA_R + 1.6, 56),
  new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.95, metalness: 0.05 }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
// outer rim + teal inlay ring
const rim = new THREE.Mesh(new THREE.RingGeometry(ARENA_R + 0.4, ARENA_R + 1.6, 56),
  new THREE.MeshStandardMaterial({ color: 0x4a3d2c, roughness: 1 }));
rim.rotation.x = -Math.PI / 2; rim.position.y = 0.01; scene.add(rim);
const inlay = new THREE.Mesh(new THREE.RingGeometry(ARENA_R - 0.35, ARENA_R - 0.05, 56),
  new THREE.MeshBasicMaterial({ color: 0x2a8a7a }));
inlay.rotation.x = -Math.PI / 2; inlay.position.y = 0.02; scene.add(inlay);
// ground beyond the arena
const outer = new THREE.Mesh(new THREE.CircleGeometry(60, 40),
  new THREE.MeshStandardMaterial({ color: 0x14100c, roughness: 1 }));
outer.rotation.x = -Math.PI / 2; outer.position.y = -0.05; scene.add(outer);

// ---------- prism tower ----------
const towerGroup = new THREE.Group();
scene.add(towerGroup);
{
  const brass = new THREE.MeshStandardMaterial({ color: 0x8a6d3b, roughness: 0.45, metalness: 0.8 });
  const stone = new THREE.MeshStandardMaterial({ color: 0x3d362e, roughness: 0.9 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.7, 0.7, 8), stone);
  base.position.y = 0.35; towerGroup.add(base);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.9, 2.0, 8), stone);
  shaft.position.y = 1.7; towerGroup.add(shaft);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.16, 10, 8), brass);
  collar.rotation.x = Math.PI / 2; collar.position.y = 2.75; towerGroup.add(collar);
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.5, 0.6, 8), brass);
  cup.position.y = 3.0; towerGroup.add(cup);
}
const crystal = new THREE.Mesh(
  new THREE.OctahedronGeometry(1.15),
  new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xff8c1a, emissiveIntensity: 1.6, roughness: 0.2, metalness: 0.1 }),
);
crystal.scale.set(1, 1.9, 1);
crystal.position.y = 4.6;
towerGroup.add(crystal);
const coreGlow = new THREE.Mesh(new THREE.CircleGeometry(2.6, 32),
  new THREE.MeshBasicMaterial({ color: 0xff9a2a, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }));
coreGlow.rotation.x = -Math.PI / 2; coreGlow.position.y = 0.03; scene.add(coreGlow);

// ---------- rotating light beams ----------
function wedgeGeometry(rIn, rOut, half) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, rOut, -half, half, false);
  shape.absarc(0, 0, rIn, half, -half, true);
  const geo = new THREE.ShapeGeometry(shape, 24);
  geo.rotateX(-Math.PI / 2);
  return geo;
}
const beamGroup = new THREE.Group();
scene.add(beamGroup);
const beamMeshes = [];
for (let i = 0; i < BEAM_COUNT; i++) {
  const wedge = new THREE.Mesh(wedgeGeometry(2.4, ARENA_R, BEAM_HALF),
    new THREE.MeshBasicMaterial({ color: 0xffc861, transparent: true, opacity: 0.30, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  wedge.position.y = 0.05;
  const hot = new THREE.Mesh(wedgeGeometry(2.4, ARENA_R, BEAM_HALF * 0.45),
    new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  hot.position.y = 0.06;
  const holder = new THREE.Group();
  holder.add(wedge); holder.add(hot);
  holder.rotation.y = (i / BEAM_COUNT) * Math.PI * 2;
  beamGroup.add(holder);
  beamMeshes.push(holder);
}
// beam source glow: small vertical light shaft at the crystal
const shaftGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.4, 3.4, 12, 1, true),
  new THREE.MeshBasicMaterial({ color: 0xffc861, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
shaftGlow.position.y = 4.4; towerGroup.add(shaftGlow);

// ---------- rifts (3 spawn portals at the rim) ----------
const RIFT_ANGLES = [Math.PI / 2, Math.PI / 2 + (Math.PI * 2) / 3, Math.PI / 2 + (Math.PI * 4) / 3];
const rifts = [];
for (const a of RIFT_ANGLES) {
  const g = new THREE.Group();
  const x = Math.sin(a) * (ARENA_R - 1.2), z = Math.cos(a) * (ARENA_R - 1.2);
  g.position.set(x, 0, z);
  g.lookAt(0, 0, 0);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.14, 10, 28),
    new THREE.MeshStandardMaterial({ color: 0x3a0f22, emissive: 0xc81e5b, emissiveIntensity: 1.4, roughness: 0.4 }));
  ring.position.y = 1.7; g.add(ring);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1.42, 28),
    new THREE.MeshBasicMaterial({ color: 0x2a0618, transparent: true, opacity: 0.92 }));
  disc.position.y = 1.7; g.add(disc);
  const glow = new THREE.Mesh(new THREE.CircleGeometry(2.1, 28),
    new THREE.MeshBasicMaterial({ color: 0xc81e5b, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.04; g.add(glow);
  const spawnRing = new THREE.Mesh(new THREE.RingGeometry(0.6, 1.0, 28),
    new THREE.MeshBasicMaterial({ color: 0xff2a55, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  spawnRing.rotation.x = -Math.PI / 2; spawnRing.position.y = 0.05; g.add(spawnRing);
  scene.add(g);
  rifts.push({ group: g, ring, disc, glow, spawnRing, angle: a, pos: new THREE.Vector3(x, 0, z), flash: 0 });
}

// ---------- pillars (6 low cover stones) ----------
const pillars = [];
{
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x4a4238, roughness: 0.95 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x8a6d3b, roughness: 0.5, metalness: 0.6 });
  for (let i = 0; i < 6; i++) {
    // B04: pillars at 0/60/120/180/240/300 deg — rotated 30 deg off the old
    // 30/90/150/... ring so NO pillar sits on a rift radial (rifts at
    // 90/210/330 deg). Nearest pillar is now ~4.3 units lateral from a rift
    // line, so tower-targeting enemies walk past instead of jamming on the
    // pillar collision circle forever.
    const a = (i / 6) * Math.PI * 2;
    const x = Math.sin(a) * 8.6, z = Math.cos(a) * 8.6;
    const p = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.9, 1.7, 8), stoneMat);
    body.position.y = 0.85; p.add(body);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.18, 8), capMat);
    cap.position.y = 1.78; p.add(cap);
    p.position.set(x, 0, z);
    scene.add(p);
    pillars.push({ pos: new THREE.Vector3(x, 0, z), r: 1.0 });
  }
}
function collideCircles(pos, radius) {
  // keep inside arena
  const d = Math.hypot(pos.x, pos.z);
  if (d > ARENA_R - radius) { pos.x *= (ARENA_R - radius) / d; pos.z *= (ARENA_R - radius) / d; }
  // tower
  const dt = Math.hypot(pos.x, pos.z);
  if (dt < 2.4 + radius) { const s = (2.4 + radius) / Math.max(dt, 0.001); pos.x *= s; pos.z *= s; }
  // pillars
  for (const p of pillars) {
    const dx = pos.x - p.pos.x, dz = pos.z - p.pos.z;
    const dd = Math.hypot(dx, dz), min = p.r + radius;
    if (dd < min && dd > 0.001) { pos.x = p.pos.x + dx / dd * min; pos.z = p.pos.z + dz / dd * min; }
  }
}

// ---------- models ----------
const loader = new GLTFLoader();
const mixers = [];
const templates = {};   // type -> { scene, animations }
const MODELS = {
  knight: './models/armoured-knight-hero-07121f.glb',
  stalker: './models/ashen-assassin-base.glb',
  shooter: './models/ashen-assassin-base.glb',
  brute: './models/orc-brute-08c6ca.glb',
  boss: './models/furnace-golem-base.glb',
};
function normalizeModel(obj, targetHeight) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3(); box.getSize(size);
  const s = targetHeight / Math.max(size.y, 0.01);
  obj.scale.setScalar(s);
  const box2 = new THREE.Box3().setFromObject(obj);
  obj.position.y -= box2.min.y; // feet on y=0 (inside a wrapper we keep at 0)
  return obj;
}
function makeCharacter(type) {
  const t = templates[type];
  const obj = cloneSkinned(t.scene);
  // Clone materials per instance: SkeletonUtils.clone shares the template's
  // materials, so a hit-flash (emissive) on one enemy would otherwise flash
  // every enemy of that type at once.
  obj.traverse((n) => {
    if (n.isMesh && n.material) {
      n.material = Array.isArray(n.material) ? n.material.map((m) => m.clone()) : n.material.clone();
    }
  });
  normalizeModel(obj, ENEMY_DEF[type === 'knight' ? 'stalker' : type].height || 1.85);
  const mixer = new THREE.AnimationMixer(obj);
  mixers.push(mixer);
  return { obj, mixer, clips: t.animations };
}
function playClip(ch, name) {
  if (!ch.clips.length) return;
  const clip = THREE.AnimationClip.findByName(ch.clips, name) ?? ch.clips[0];
  if (ch.current === clip) return;
  ch.current = clip;
  ch.mixer.stopAllAction();
  ch.mixer.clipAction(clip).play();
}
function tintCharacter(obj, color) {
  obj.traverse((n) => {
    if (n.isMesh && n.material) {
      n.material = n.material.clone();
      if (n.material.color) n.material.color.multiply(new THREE.Color(color));
    }
  });
}
function blobShadow(obj, radius) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 20),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.02;
  obj.add(m);
  return m;
}

// ---------- "SLOWED" mark for enemies caught in a beam (Jin polish) ----------
// One shared canvas texture (procedural sun + SLOWED text) and one shared gold
// ring; each enemy gets its own sprite + ring mesh, shown only while lit.
function makeSlowMarkTexture() {
  const c = document.createElement('canvas');
  c.width = 340; c.height = 72;
  const g = c.getContext('2d');
  g.fillStyle = '#ffd98a'; g.strokeStyle = '#ffd98a'; g.lineWidth = 5;
  g.beginPath(); g.arc(34, 36, 15, 0, Math.PI * 2); g.fill();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.beginPath();
    g.moveTo(34 + Math.cos(a) * 21, 36 + Math.sin(a) * 21);
    g.lineTo(34 + Math.cos(a) * 29, 36 + Math.sin(a) * 29);
    g.stroke();
  }
  g.font = 'bold 40px Georgia, "Times New Roman", serif';
  g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText('SLOWED', 66, 38);
  g.fillStyle = '#ffe9b0';
  g.fillText('SLOWED', 66, 38);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const slowMarkMat = new THREE.SpriteMaterial({ map: makeSlowMarkTexture(), transparent: true, depthWrite: false });
const slowRingGeo = new THREE.RingGeometry(0.92, 1.12, 32);
const slowRingMat = new THREE.MeshBasicMaterial({ color: 0xffc861, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
function attachSlowMark(e) {
  const mark = new THREE.Sprite(slowMarkMat);
  mark.scale.set(3.0, 0.64, 1);
  mark.position.y = e.def.height + 0.8;
  mark.visible = false;
  e.obj.add(mark);
  const ring = new THREE.Mesh(slowRingGeo, slowRingMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  ring.scale.setScalar(e.def.radius + 0.3);
  ring.visible = false;
  e.obj.add(ring);
  e.slowMark = mark;
  e.slowRing = ring;
}
function setSlowMark(e, lit) {
  if (e.slowMark) e.slowMark.visible = lit;
  if (e.slowRing) e.slowRing.visible = lit;
}

// ---------- projectiles / particles / pickups ----------
const boltGeo = new THREE.SphereGeometry(0.22, 10, 8);
const boltMat = new THREE.MeshBasicMaterial({ color: 0xffd98a });
const boltCoreMat = new THREE.MeshBasicMaterial({ color: 0xfff6d8 });
const eboltMat = new THREE.MeshBasicMaterial({ color: 0xd040ff });
function spawnBolt(from, dir, speed, range, dmg, spread = 0) {
  const mesh = new THREE.Mesh(boltGeo, boltMat);
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), boltCoreMat);
  mesh.add(core);
  mesh.scale.set(1, 1, 2.6);
  const d = dir.clone();
  if (spread) { const a = Math.atan2(d.x, d.z) + spread; d.set(Math.sin(a), 0, Math.cos(a)); }
  mesh.position.copy(from).add(new THREE.Vector3(0, 1.1, 0));
  mesh.lookAt(mesh.position.clone().add(d));
  scene.add(mesh);
  G.bolts.push({ mesh, vel: d.multiplyScalar(speed), left: range, dmg });
}
function spawnEBolt(from, dir, speed, dmg) {
  const mesh = new THREE.Mesh(boltGeo, eboltMat);
  mesh.scale.set(1, 1, 2.2);
  mesh.position.copy(from).add(new THREE.Vector3(0, 1.2, 0));
  mesh.lookAt(mesh.position.clone().add(dir));
  scene.add(mesh);
  G.ebolts.push({ mesh, vel: dir.clone().multiplyScalar(speed), left: 26, dmg });
}
const particleGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(600 * 3);
  particleGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
}
const particleMat = new THREE.PointsMaterial({ color: 0xffc861, size: 0.28, transparent: true, opacity: 0.95, depthWrite: false });
const particlePoints = new THREE.Points(particleGeo, particleMat);
particlePoints.frustumCulled = false;
scene.add(particlePoints);
const P_MAX = 600;
const pData = []; // {x,y,z,vx,vy,vz,life,maxLife,r,g,b}
function burst(pos, color, n = 18, speed = 4) {
  for (let i = 0; i < n && pData.length < P_MAX; i++) {
    const a = rand() * Math.PI * 2, up = rand() * 0.8 + 0.2, sp = speed * (0.4 + rand() * 0.8);
    pData.push({ x: pos.x, y: pos.y + 0.8, z: pos.z, vx: Math.cos(a) * sp, vy: up * sp, vz: Math.sin(a) * sp, life: 0.55 + rand() * 0.3, maxLife: 0.85 });
  }
  particleMat.color.set(color);
}
function updateParticles(dt) {
  const arr = particleGeo.attributes.position.array;
  for (let i = pData.length - 1; i >= 0; i--) {
    const p = pData[i];
    p.life -= dt;
    if (p.life <= 0) { pData.splice(i, 1); continue; }
    p.vy -= 9 * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    if (p.y < 0.05) { p.y = 0.05; p.vy *= -0.4; }
  }
  for (let i = 0; i < P_MAX; i++) {
    const p = pData[i];
    if (p) { arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z; }
    else { arr[i * 3 + 1] = -100; }
  }
  particleGeo.attributes.position.needsUpdate = true;
}
// damage numbers (DOM, projected)
const dmgPool = [];
for (let i = 0; i < 28; i++) {
  const d = document.createElement('div');
  d.className = 'dmgnum'; d.style.display = 'none';
  el.dmg.appendChild(d);
  dmgPool.push({ el: d, life: 0, pos: new THREE.Vector3() });
}
function showDmgNum(worldPos, text, cls = '', size = 20) {
  const slot = dmgPool.find((s) => s.life <= 0) || dmgPool[0];
  slot.life = 0.8; slot.pos.copy(worldPos);
  slot.el.textContent = text;
  slot.el.className = 'dmgnum ' + cls;
  slot.el.style.fontSize = size + 'px';
  slot.el.style.display = 'block';
}
const _v = new THREE.Vector3();
const _punchAxis = new THREE.Vector3();
const _flinchAxis = new THREE.Vector3();
function updateDmgNums(dt) {
  for (const s of dmgPool) {
    if (s.life <= 0) continue;
    s.life -= dt;
    if (s.life <= 0) { s.el.style.display = 'none'; continue; }
    _v.copy(s.pos); _v.y += (0.8 - s.life) * 1.6;
    _v.project(camera);
    if (_v.z > 1) { s.el.style.display = 'none'; continue; }
    s.el.style.left = ((_v.x * 0.5 + 0.5) * window.innerWidth) + 'px';
    s.el.style.top = ((-_v.y * 0.5 + 0.5) * window.innerHeight) + 'px';
    s.el.style.opacity = Math.min(1, s.life / 0.3);
  }
}
// embers
const emberGeo = new THREE.OctahedronGeometry(0.28);
const emberMat = new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff5a00, emissiveIntensity: 1.6 });
function spawnEmber(pos) {
  const m = new THREE.Mesh(emberGeo, emberMat);
  m.position.set(pos.x + (rand() - 0.5), 0.5, pos.z + (rand() - 0.5));
  scene.add(m);
  G.pickups.push({ mesh: m, t: rand() * 6 });
}
function inBeam(pos) {
  const d = Math.hypot(pos.x, pos.z);
  if (d < 2.2 || d > ARENA_R) return false;
  const a = Math.atan2(pos.x, pos.z);
  const base = G.beamAngle + (G.beamOffset ?? 0);
  for (let i = 0; i < BEAM_COUNT; i++) {
    const ba = base + (i / BEAM_COUNT) * Math.PI * 2;
    if (angDiff(a, ba) < BEAM_HALF) return true;
  }
  return false;
}
function startPunch(e, dir) {
  // start the procedural punch: 0.35 s lunge toward dir (see updateEnemy)
  e.punchT = 0.35; e.punchDur = 0.35;
  e.punchDir.copy(dir).setY(0);
  if (e.punchDir.lengthSq() < 0.001) e.punchDir.set(0, 0, 1);
  e.punchDir.normalize();
}
function flashEnemy(e) {
  e.flash = 0.12;
  e.obj.traverse((n) => { if (n.isMesh && n.material && n.material.emissive) n.material.emissive.setHex(0xffffff); });
}
function unflashEnemy(e) {
  e.obj.traverse((n) => { if (n.isMesh && n.material && n.material.emissive) n.material.emissive.setHex(e.baseEmissive); });
}

// ---------- enemies ----------
function spawnEnemy(type, riftIdx) {
  const def = ENEMY_DEF[type];
  const rift = rifts[riftIdx ?? Math.floor(rand() * rifts.length)];
  const ch = makeCharacter(type);
  const obj = ch.obj;
  if (type === 'shooter') tintCharacter(obj, def.color);
  if (type === 'boss') tintCharacter(obj, def.color);
  obj.position.set(rift.pos.x * 0.82, 0, rift.pos.z * 0.82);
  obj.rotation.y = Math.atan2(-obj.position.x, -obj.position.z);
  scene.add(obj);
  blobShadow(obj, def.radius * 1.1);
  const e = {
    type, def, obj, mixer: ch.mixer, clips: ch.clips, current: null,
    hp: def.hp, speed: def.speed, radius: def.radius,
    targetTower: type !== 'shooter' && (type === 'brute' || rand() < 0.55),
    attackCd: 1 + rand(), shootCd: 1.5 + rand(), windup: 0, flash: 0, baseEmissive: 0,
    lit: false, dead: false, chargeState: null, chargeDir: new THREE.Vector3(), chargeT: 0, stun: 0,
    hitCd: 0,
    // B04 emergency unstick (tower-targeters): stuckT accumulates while the
    // enemy intends to move but barely does; slideT latches a tangential
    // slide around the obstacle; slideDir picks which way around.
    stuckT: 0, slideT: 0, slideDir: rand() < 0.5 ? 1 : -1,
    // procedural punch (user feedback): no attack clip exists in the GLBs
    // (Idle/Walk/Run only), so a melee strike is a quick lunge + forward lean.
    // punchOff holds last frame's visual offset so logic always sees the
    // true position (it is subtracted at the top of the next updateEnemy).
    punchT: 0, punchDur: 0.35, punchDir: new THREE.Vector3(), punchOff: new THREE.Vector3(),
  };
  attachSlowMark(e);
  playClip(e, 'Walk');
  G.enemies.push(e);
  if (type === 'boss') { G.boss = e; }
  return e;
}
function damageEnemy(e, dmg, fromPos) {
  if (e.dead) return;
  const lit = inBeam(e.obj.position);
  e.lit = lit;
  let final = dmg * (lit ? 1.5 : 1);
  let crit = false;
  if (rand() < 0.15) { final *= 2; crit = true; }
  e.hp -= final;
  flashEnemy(e);
  showDmgNum(e.obj.position, Math.round(final) + (lit ? ' ☀' : ''), crit ? 'crit' : '', crit ? 30 : 20);
  // knockback away from shooter
  const kb = new THREE.Vector3().subVectors(e.obj.position, fromPos).setY(0).normalize().multiplyScalar(e.type === 'brute' || e.type === 'boss' ? 0.15 : 0.5);
  e.obj.position.add(kb);
  sfx.hit();
  if (e.hp <= 0) killEnemy(e);
}
function killEnemy(e) {
  if (e.dead) return;
  e.dead = true;
  G.score += e.def.score;
  burst(e.obj.position, e.type === 'boss' ? 0xff5a00 : 0xffc861, e.type === 'boss' ? 60 : 22, e.type === 'boss' ? 7 : 4);
  sfx.kill();
  G.hitStop = 0.06;
  G.shake = Math.max(G.shake, 0.22); // small camera shake on kill (Jin polish)
  if (e.type !== 'boss' && rand() < 0.5) spawnEmber(e.obj.position);
  if (e.type === 'boss') { G.boss = null; winGame(); }
  scene.remove(e.obj);
}
// Big red "CORE -1" pulse (Jin polish): 0.3 s normally, longer + distinct
// "LAST CHARGE!" text when only one charge remains.
function showCoreFlash(text, long = false) {
  el.coreFlash.textContent = text;
  el.coreFlash.classList.remove('show', 'long');
  void el.coreFlash.offsetWidth; // restart the CSS animation
  if (long) el.coreFlash.classList.add('long');
  el.coreFlash.classList.add('show');
}
function drainCore(e) {
  // enemy reached the tower
  G.core -= 1;
  burst(new THREE.Vector3(0, 2, 0), 0xff2a55, 26, 5);
  showDmgNum(new THREE.Vector3(0, 3.4, 0), 'CORE -1', 'hurt', 26);
  showCoreFlash(G.core === 1 ? '⚠ CORE -1 — LAST CHARGE!' : 'CORE -1', G.core === 1);
  sfx.warn();
  G.shake = Math.max(G.shake, 0.5);
  e.dead = true;
  scene.remove(e.obj);
  // A drained boss must clear the G.boss reference like killEnemy() does,
  // otherwise wave 5 can never clear (checkWaveClear requires !G.boss).
  if (e.type === 'boss') G.boss = null;
  updateHUD();
  if (G.core <= 0) loseGame('The prism core is drained.');
}
function updateEnemy(e, dt) {
  if (e.dead) return;
  const pos = e.obj.position;
  // strip last frame's punch lunge: game logic always sees the true position
  pos.sub(e.punchOff);
  e.punchOff.set(0, 0, 0);
  if (e.flash > 0) { e.flash -= dt; if (e.flash <= 0) unflashEnemy(e); }
  if (e.stun > 0) { e.stun -= dt; playClip(e, 'Idle'); return; }
  const lit = inBeam(pos);
  e.lit = lit;
  setSlowMark(e, lit);
  const slow = lit ? 0.55 : 1;
  // punch animation: quick lunge toward the victim + forward lean, out and
  // back over punchDur; the enemy holds still while punching.
  if (e.punchT > 0) {
    e.punchT -= dt;
    const k = 1 - Math.max(0, e.punchT) / e.punchDur;
    const ext = Math.sin(k * Math.PI);
    e.punchOff.copy(e.punchDir).multiplyScalar(ext * 0.8);
    pos.add(e.punchOff);
    objFace(e.obj, e.punchDir);
    _punchAxis.set(-e.punchDir.z, 0, e.punchDir.x);
    e.obj.rotateOnWorldAxis(_punchAxis, ext * 0.3);
    playClip(e, 'Idle');
    return;
  }
  // boss special attacks
  if (e.type === 'boss') { updateBoss(e, dt, slow); return; }
  // telegraph windup for brute heavy attack
  if (e.windup > 0) {
    e.windup -= dt;
    if (e.windup <= 0) {
      // slam lands
      burst(pos, 0xff2a55, 14, 3);
      if (dist2d(pos, player.pos) < 2.6 && player.invuln <= 0) hurtPlayer(e.def.dmg, pos);
      sfx.slam();
      G.shake = Math.max(G.shake, 0.3);
      startPunch(e, new THREE.Vector3().subVectors(player.pos, pos));
    }
    playClip(e, 'Idle');
    return;
  }
  const toPlayer = new THREE.Vector3().subVectors(player.pos, pos).setY(0);
  const dPlayer = toPlayer.length();
  const toTower = new THREE.Vector3(-pos.x, 0, -pos.z);
  const dTower = toTower.length();
  let move = new THREE.Vector3();
  if (e.type === 'shooter') {
    // keep distance 8-10 from player, strafe
    if (dPlayer > 10) move.copy(toPlayer.normalize());
    else if (dPlayer < 7) move.copy(toPlayer.normalize()).multiplyScalar(-1);
    else move.set(-toPlayer.z, 0, toPlayer.x).normalize().multiplyScalar(Math.sin(G.time * 0.7 + e.attackCd) > 0 ? 1 : -1);
    e.shootCd -= dt;
    if (e.shootCd <= 0 && dPlayer < 15) {
      e.shootCd = 2.2 + rand() * 0.6;
      const dir = toPlayer.normalize();
      spawnEBolt(pos, dir, 11, e.def.dmg);
      sfx.bolt();
    }
  } else if (e.targetTower) {
    move.copy(toTower.normalize());
    // drain threshold must sit above the tower-collision clamp (2.4 + radius),
    // otherwise the clamp keeps the enemy out of drain range forever.
    if (dTower < 2.4 + e.radius + 0.3) { drainCore(e); return; }
    // B04 emergency unstick: while slideT is latched, blend a tangential
    // component into the move so the enemy walks around whatever blocked it
    // instead of pushing into it forever.
    if (e.slideT > 0) {
      const tang = new THREE.Vector3(-toTower.z, 0, toTower.x).normalize().multiplyScalar(e.slideDir);
      move.add(tang).normalize();
    }
  } else {
    move.copy(toPlayer.normalize());
    if (dPlayer < e.radius + player.radius + 0.25) {
      objFace(e.obj, toPlayer);
      e.attackCd -= dt;
      if (e.attackCd <= 0) {
        e.attackCd = 1.1;
        if (e.type === 'brute') {
          e.windup = 0.7; // telegraphed heavy slam
          showTelegraph(pos, 2.6, 0.7);
          sfx.warn();
        } else {
          hurtPlayer(e.def.dmg, pos);
          startPunch(e, toPlayer);
        }
      }
      playClip(e, 'Idle');
      return;
    }
  }
  const prevX = pos.x, prevZ = pos.z;
  const step = move.multiplyScalar(e.speed * slow * dt);
  pos.add(step);
  collideCircles(pos, e.radius);
  // B04 stuck detection (tower-targeters): if we intended to move but the
  // collision pushback cancelled it (~no displacement), accumulate stuckT;
  // after ~2 s of no progress, latch a 1.5 s tangential slide. Re-triggers
  // if still blocked afterwards, so a tower-targeter can never freeze forever.
  if (e.targetTower) {
    if (e.slideT > 0) e.slideT -= dt;
    else if (step.lengthSq() > 0.000001) {
      const moved = Math.hypot(pos.x - prevX, pos.z - prevZ);
      if (moved < 0.01) {
        e.stuckT += dt;
        if (e.stuckT > 2) { e.slideT = 1.5; e.stuckT = 0; }
      } else e.stuckT = 0;
    } else e.stuckT = 0;
  }
  if (step.lengthSq() > 0.000001) {
    objFace(e.obj, move);
    playClip(e, 'Walk');
  } else playClip(e, 'Idle');
}
function objFace(obj, dir) {
  obj.rotation.y = Math.atan2(dir.x, dir.z);
}
// red telegraph ring on the ground (grows, then fades)
const teleGeo = new THREE.RingGeometry(0.85, 1, 32);
const teleMat = new THREE.MeshBasicMaterial({ color: 0xff2a33, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false });
function showTelegraph(pos, radius, dur) {
  const m = new THREE.Mesh(teleGeo, teleMat.clone());
  m.rotation.x = -Math.PI / 2;
  m.position.set(pos.x, 0.06, pos.z);
  m.scale.setScalar(radius);
  scene.add(m);
  G.telegraphs = G.telegraphs || [];
  G.telegraphs.push({ mesh: m, life: dur, max: dur });
}
function updateTelegraphs(dt) {
  if (!G.telegraphs) return;
  for (let i = G.telegraphs.length - 1; i >= 0; i--) {
    const t = G.telegraphs[i];
    t.life -= dt;
    t.mesh.material.opacity = 0.7 * Math.max(0, t.life / t.max);
    if (t.life <= 0) { scene.remove(t.mesh); t.mesh.material.dispose(); G.telegraphs.splice(i, 1); }
  }
}
function updateBoss(e, dt, slow) {
  const pos = e.obj.position;
  const toPlayer = new THREE.Vector3().subVectors(player.pos, pos).setY(0);
  const dPlayer = toPlayer.length();
  const toTower = new THREE.Vector3(-pos.x, 0, -pos.z);
  const dTower = toTower.length();
  // core exposed while caught in the light
  const exposed = inBeam(pos);
  setSlowMark(e, exposed);
  if (exposed) {
    crystal.material.emissiveIntensity = 2.2;
    // hit-flash (white emissive) takes precedence over the exposed tint
    if (e.flash <= 0) e.obj.traverse((n) => { if (n.isMesh && n.material && n.material.emissive) n.material.emissive.setHex(0x662200); });
  } else {
    e.obj.traverse((n) => { if (n.isMesh && n.material && n.material.emissive && e.flash <= 0) n.material.emissive.setHex(0x000000); });
  }
  if (e.chargeState === 'windup') {
    e.chargeT -= dt;
    if (e.chargeT <= 0) { e.chargeState = 'rush'; e.chargeT = 0.7; sfx.bossMotif(1); }
    playClip(e, 'Idle');
    return;
  }
  if (e.chargeState === 'rush') {
    e.chargeT -= dt;
    pos.addScaledVector(e.chargeDir, 9 * dt);
    collideCircles(pos, e.radius);
    if (dist2d(pos, player.pos) < e.radius + player.radius + 0.3 && player.invuln <= 0) hurtPlayer(25, pos);
    if (e.chargeT <= 0) { e.chargeState = null; e.stun = 1.0; }
    playClip(e, 'Run');
    return;
  }
  if (e.windup > 0) { // slam windup
    e.windup -= dt;
    if (e.windup <= 0) {
      burst(pos, 0xff5a00, 40, 6);
      sfx.slam();
      G.shake = 1.0;
      if (dist2d(pos, player.pos) < 4.6 && player.invuln <= 0) hurtPlayer(e.def.dmg, pos);
      if (dTower < 5.2) { G.core -= 1; showDmgNum(new THREE.Vector3(0, 3.4, 0), 'CORE -1', 'hurt', 26); showCoreFlash(G.core === 1 ? '⚠ CORE -1 — LAST CHARGE!' : 'CORE -1', G.core === 1); sfx.warn(); updateHUD(); if (G.core <= 0) { loseGame('The Furnace Maw shattered the prism core.'); return; } }
    }
    playClip(e, 'Idle');
    return;
  }
  e.attackCd -= dt;
  if (e.attackCd <= 0) {
    if (dPlayer < 4.2 || dTower < 4.6) {
      e.attackCd = 3.2;
      e.windup = 1.0;
      showTelegraph(pos, 4.6, 1.0);
      sfx.bossMotif(0);
      playClip(e, 'Idle');
      return;
    }
    if (dPlayer > 6 && dPlayer < 14 && rand() < 0.6) {
      e.attackCd = 4.0;
      e.chargeState = 'windup'; e.chargeT = 0.6;
      e.chargeDir.copy(toPlayer.normalize());
      showTelegraph(pos.clone().addScaledVector(e.chargeDir, 4), 1.2, 0.6);
      sfx.bossMotif(2);
      playClip(e, 'Idle');
      return;
    }
    e.attackCd = 0.5;
  }
  // chase player, or tower if very close (drain threshold must sit above the
  // tower-collision clamp of 2.4 + radius = 4.3 for the boss, else unreachable)
  const target = dTower < 2.4 + e.radius + 0.3 ? toTower : toPlayer;
  const move = target.clone().normalize().multiplyScalar(e.speed * slow * dt);
  pos.add(move);
  collideCircles(pos, e.radius);
  if (move.lengthSq() > 0.000001) { objFace(e.obj, move); playClip(e, 'Walk'); }
  else playClip(e, 'Idle');
  if (dTower < 2.4 + e.radius + 0.3) { drainCore(e); }
}

// ---------- player ----------
function hurtPlayer(dmg, fromPos) {
  if (player.invuln > 0 || G.state !== 'playing') return;
  player.hp -= dmg;
  player.invuln = 0.7;
  // hit reaction (user feedback): crouch + stagger away from the hit, 0.3 s
  player.flinchT = 0.3;
  player.flinchDir.copy(player.pos).sub(fromPos).setY(0);
  if (player.flinchDir.lengthSq() < 0.001) player.flinchDir.set(0, 0, 1);
  else player.flinchDir.normalize();
  showDmgNum(player.pos, '-' + dmg, 'hurt', 24);
  burst(player.pos, 0xff3a2a, 12, 3);
  sfx.hurt();
  G.shake = Math.max(G.shake, 0.45);
  updateHUD();
  if (player.hp <= 0) { player.hp = 0; loseGame('The Guardian has fallen.'); }
}
function updatePlayer(dt) {
  // movement (camera is fixed angle: screen-up = -z)
  const mx = (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0) - (keys['KeyA'] || keys['ArrowLeft'] ? 1 : 0);
  const mz = (keys['KeyS'] || keys['ArrowDown'] ? 1 : 0) - (keys['KeyW'] || keys['ArrowUp'] ? 1 : 0);
  const mv = new THREE.Vector3(mx, 0, mz);
  if (mv.lengthSq() > 0) mv.normalize();
  player.moving = mv.lengthSq() > 0;
  if (player.dashTime > 0) {
    player.dashTime -= dt;
    player.pos.addScaledVector(player.dashDir, 16 * dt);
    burst(player.pos, 0x57d9c5, 2, 2);
  } else if (player.moving) {
    player.pos.addScaledVector(mv, player.speed * dt);
  }
  collideCircles(player.pos, player.radius);
  if (player.moving || player.dashTime > 0) {
    const face = player.dashTime > 0 ? player.dashDir : mv;
    player.obj.rotation.y = Math.atan2(face.x, face.z);
    playClip(player, 'Run');
  } else playClip(player, 'Idle');
  player.obj.position.copy(player.pos);
  // aim: mouse ray to floor plane (or the scripted bot aim in shot mode)
  if (botAim) {
    player.aim.copy(botAim);
  } else {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(mouseNDC, camera);
    const t = -ray.ray.origin.y / ray.ray.direction.y;
    if (t > 0) {
      const p = ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
      player.aim.set(p.x - player.pos.x, 0, p.z - player.pos.z).normalize();
    }
  }
  // fire (hold to shoot)
  player.fireCd -= dt;
  if (mouseDown && player.fireCd <= 0) {
    player.fireCd = 0.28;
    const range = 16 * (1 + 0.35 * G.upg.lens);
    const speed = 26 * (1 + 0.15 * G.upg.lens);
    const n = 1 + G.upg.twin;
    for (let i = 0; i < n; i++) {
      const spread = n > 1 ? (i - (n - 1) / 2) * 0.14 : 0;
      spawnBolt(player.pos, player.aim, speed, range, 34, spread);
    }
    sfx.bolt();
  }
  player.dashCd -= dt;
  player.invuln -= dt;
  if (player.invuln > 0 && player.obj) {
    // keep the flinch fully visible: blink only once the crouch is over
    player.obj.visible = player.flinchT > 0 ? true : (Math.floor(G.time * 14) % 2 === 0);
  } else if (player.obj) player.obj.visible = true;
  // flinch: crouch down + hunch forward + stagger back, out and back over 0.3 s.
  // Applied after obj.position.copy(player.pos) above, so it is purely visual
  // and is overwritten by the next frame's copy.
  if (player.flinchT > 0 && player.obj) {
    player.flinchT -= dt;
    const k = 1 - Math.max(0, player.flinchT) / 0.3;
    const ext = Math.sin(k * Math.PI);
    player.obj.position.y -= 0.45 * ext;
    player.obj.position.addScaledVector(player.flinchDir, 0.35 * ext);
    const yaw = Math.atan2(player.aim.x, player.aim.z);
    player.obj.rotation.set(0, yaw, 0);
    _flinchAxis.set(-player.aim.z, 0, player.aim.x);
    player.obj.rotateOnWorldAxis(_flinchAxis, 0.45 * ext);
  }
  // dash
  if (keys['Space'] && player.dashCd <= 0 && player.dashTime <= 0) {
    keys['Space'] = false;
    const dir = player.moving ? mv.clone() : player.aim.clone();
    player.dashDir.copy(dir);
    player.dashTime = 0.18;
    player.dashCd = Math.max(0.8, 2.5 * Math.pow(0.7, G.upg.quick));
    player.invuln = Math.max(player.invuln, 0.25);
    sfx.dash();
  }
  // beam rotate
  G.qCd -= dt;
  if (keys['KeyQ'] && G.qCd <= 0) {
    keys['KeyQ'] = false;
    G.beamTarget += Math.PI / 3; // 60 degrees
    G.qCd = 2.0;
    sfx.pickup();
  }
  // embers magnet + pickup
  const magnetR = 1.3 + G.upg.ember * 1.2;
  for (let i = G.pickups.length - 1; i >= 0; i--) {
    const pk = G.pickups[i];
    pk.t += dt;
    pk.mesh.position.y = 0.5 + Math.sin(pk.t * 3) * 0.12;
    pk.mesh.rotation.y += dt * 2;
    const d = dist2d(pk.mesh.position, player.pos);
    if (d < magnetR + 0.6) pk.mesh.position.lerp(new THREE.Vector3(player.pos.x, 0.5, player.pos.z), dt * 6);
    if (d < 1.1) {
      const heal = 6 * (G.upg.ember > 0 ? 2 : 1);
      player.hp = Math.min(player.hpMax, player.hp + heal);
      G.embers += 1;
      showDmgNum(player.pos, '+' + heal + ' HP', 'heal', 20);
      burst(player.pos, 0xff7a1a, 8, 2);
      sfx.pickup();
      scene.remove(pk.mesh);
      G.pickups.splice(i, 1);
      updateHUD();
    }
  }
}
function updateBolts(dt) {
  for (let i = G.bolts.length - 1; i >= 0; i--) {
    const b = G.bolts[i];
    b.mesh.position.addScaledVector(b.vel, dt);
    b.left -= b.vel.length() * dt;
    let hit = false;
    for (const e of G.enemies) {
      if (e.dead) continue;
      const d = Math.hypot(b.mesh.position.x - e.obj.position.x, b.mesh.position.z - e.obj.position.z);
      if (d < e.radius + 0.35 && b.mesh.position.y < 3.2) {
        damageEnemy(e, b.dmg, player.pos);
        burst(b.mesh.position, 0xffd98a, 6, 2);
        hit = true;
        break;
      }
    }
    if (hit || b.left <= 0 || Math.hypot(b.mesh.position.x, b.mesh.position.z) > ARENA_R + 1) {
      scene.remove(b.mesh);
      G.bolts.splice(i, 1);
    }
  }
  for (let i = G.ebolts.length - 1; i >= 0; i--) {
    const b = G.ebolts[i];
    b.mesh.position.addScaledVector(b.vel, dt);
    b.left -= b.vel.length() * dt;
    const d = Math.hypot(b.mesh.position.x - player.pos.x, b.mesh.position.z - player.pos.z);
    if (d < player.radius + 0.3) {
      hurtPlayer(b.dmg, b.mesh.position);
      scene.remove(b.mesh);
      G.ebolts.splice(i, 1);
      continue;
    }
    if (b.left <= 0 || Math.hypot(b.mesh.position.x, b.mesh.position.z) > ARENA_R + 1) {
      scene.remove(b.mesh);
      G.ebolts.splice(i, 1);
    }
  }
}

// ---------- waves / upgrades / states ----------
function showBanner(title, sub, dur = 2.2) {
  el.bannerTitle.textContent = title;
  el.bannerSub.textContent = sub;
  el.banner.classList.remove('hidden');
  G.bannerTimer = dur;
}
function startWave(n) {
  G.wave = n;
  G.waveTime = 0;
  G.spawnQueue = [...WAVE_COMP[n - 1]];
  G.spawnTimer = 0.5;
  G.bossAddsTimer = 10;
  const names = { 1: 'The Stalkers come', 2: 'Shooters in the dark', 3: 'Brutes at the gate', 4: 'The horde thickens', 5: 'FURNACE MAW AWAKENS' };
  showBanner('WAVE ' + n, names[n] || '');
  if (n === 5) sfx.bossMotif(2);
  else sfx.horn();
  updateHUD();
}
function waveClearBonus() {
  const remaining = Math.max(0, PAR_TIME[G.wave - 1] - G.waveTime);
  return 300 + Math.round(remaining) * 10;
}
function checkWaveClear() {
  if (G.state !== 'playing') return;
  if (G.spawnQueue.length === 0 && G.enemies.length === 0 && !G.boss) {
    const bonus = waveClearBonus();
    G.score += bonus;
    sfx.waveClear();
    if (G.wave >= 5) { winGame(); return; }
    openUpgrade(bonus);
  }
}
function openUpgrade(bonus) {
  G.state = 'upgrade';
  G.upgradeTimer = 8;
  // No wave-clear banner here: the upgrade overlay already has its own
  // "WAVE CLEARED" heading, and a banner would show through it. Hide any
  // banner still running (e.g. from the wave start) as well.
  el.banner.classList.add('hidden');
  G.bannerTimer = 0;
  // pick 3 distinct available upgrades
  const avail = UPGRADES.filter((u) => G.upg[u.id] < u.max);
  const picks = [];
  while (picks.length < 3 && avail.length > 0) {
    const i = Math.floor(rand() * avail.length);
    picks.push(avail.splice(i, 1)[0]);
  }
  G.upgradeChoices = picks;
  el.cards.innerHTML = '';
  picks.forEach((u, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="ico">${u.ico}</div><h3>${u.name}</h3><p>${u.desc}</p><span class="key">Press ${i + 1} or click</span>`;
    card.addEventListener('click', () => applyUpgrade(u));
    el.cards.appendChild(card);
  });
  el.upgrade.classList.remove('hidden');
}
function applyUpgrade(u) {
  if (G.state !== 'upgrade') return;
  G.upg[u.id] += 1;
  if (u.id === 'heart') { G.core = Math.min(G.coreMax, G.core + 1); }
  sfx.pickup();
  el.upgrade.classList.add('hidden');
  G.state = 'playing';
  startWave(G.wave + 1);
}
function winGame() {
  if (G.state === 'victory' || G.state === 'defeat') return;
  G.score += 100 * G.core;
  G.state = 'victory';
  finishRun(true, 'The prism burns bright again — the Furnace Maw is slain.');
}
function loseGame(reason) {
  if (G.state === 'victory' || G.state === 'defeat') return;
  G.state = 'defeat';
  sfx.defeat();
  sfx.stopMusic();
  finishRun(false, reason);
}
function finishRun(won, reason) {
  if (G.score > G.best) { G.best = G.score; try { localStorage.setItem(BEST_KEY, String(G.best)); } catch {} }
  el.endTitle.textContent = won ? 'VICTORY' : 'DEFEAT';
  el.endTitle.className = won ? 'win' : 'lose';
  el.endSub.textContent = reason;
  el.endScore.textContent = G.score.toLocaleString();
  el.endWave.textContent = G.wave + (won ? '' : ' / 5');
  el.endBest.textContent = G.best.toLocaleString();
  el.hud.classList.add('hidden');
  el.dmg.classList.add('hidden');
  el.banner.classList.add('hidden');
  el.upgrade.classList.add('hidden');
  el.endcard.classList.remove('hidden');
  updateHUD();
}
function resetRun() {
  for (const e of G.enemies) scene.remove(e.obj);
  for (const b of G.bolts) scene.remove(b.mesh);
  for (const b of G.ebolts) scene.remove(b.mesh);
  for (const p of G.pickups) scene.remove(p.mesh);
  if (G.telegraphs) for (const t of G.telegraphs) scene.remove(t.mesh);
  G.enemies = []; G.bolts = []; G.ebolts = []; G.pickups = []; G.telegraphs = [];
  pData.length = 0;
  G.score = 0; G.embers = 0; G.core = 5; G.wave = 1; G.waveTime = 0;
  G.spawnQueue = []; G.boss = null; G.beamAngle = 0; G.beamTarget = 0; G.qCd = 0;
  G.upg = { twin: 0, lens: 0, heart: 0, quick: 0, ember: 0 };
  player.hp = player.hpMax;
  player.pos.set(0, 0, 6);
  player.fireCd = 0; player.dashCd = 0; player.dashTime = 0; player.invuln = 0;
  if (player.obj) { player.obj.position.copy(player.pos); player.obj.visible = true; }
  el.endcard.classList.add('hidden');
  el.upgrade.classList.add('hidden');
  el.pause.classList.add('hidden');
  el.title.classList.add('hidden');
  el.hud.classList.remove('hidden');
  el.dmg.classList.remove('hidden');
}
function startGame() {
  sfx.ensure();
  sfx.startMusic();
  resetRun();
  G.state = 'playing';
  startWave(1);
}

// ---------- HUD ----------
function updateHUD() {
  el.hpFill.style.width = Math.max(0, player.hp / player.hpMax * 100) + '%';
  el.hpText.textContent = Math.max(0, Math.ceil(player.hp));
  let coreHtml = '';
  for (let i = 0; i < G.coreMax; i++) coreHtml += i < G.core ? '<span class="on">◆</span>' : '<span class="off">◆</span>';
  el.core.innerHTML = coreHtml || '<span class="off">◆</span>';
  // last-charge warning: pulse the PRISM CORE panel red while 1 is left
  el.corePanel.classList.toggle('critical', G.core === 1);
  el.waveText.textContent = G.wave;
  const t = Math.floor(G.waveTime);
  const par = PAR_TIME[G.wave - 1];
  el.waveTimer.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} / ${Math.floor(par / 60)}:${String(par % 60).padStart(2, '0')}`;
  el.scoreText.textContent = G.score.toLocaleString();
  el.emberText.textContent = G.embers;
  el.bestText.textContent = G.best.toLocaleString();
  el.qFill.style.width = Math.round(clamp(1 - G.qCd / 2.0, 0, 1) * 100) + '%';
  const dashMax = Math.max(0.8, 2.5 * Math.pow(0.7, G.upg.quick));
  el.dashFill.style.width = Math.round(clamp(1 - player.dashCd / dashMax, 0, 1) * 100) + '%';
}

// ---------- input ----------
window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Space') ev.preventDefault();
  keys[ev.code] = true;
  sfx.ensure();
  if (ev.code === 'Enter') {
    if (G.state === 'title') startGame();
    else if (G.state === 'victory' || G.state === 'defeat') startGame();
  }
  if (ev.code === 'KeyR' && (G.state === 'playing' || G.state === 'victory' || G.state === 'defeat' || G.state === 'paused' || G.state === 'upgrade')) startGame();
  if (ev.code === 'Escape' || ev.code === 'KeyP') {
    if (G.state === 'playing') {
      G.pausedFrom = 'playing'; G.state = 'paused'; el.pause.classList.remove('hidden');
      // B01: hide the wave banner while paused so it never sits behind PAUSED
      el.banner.classList.add('hidden');
    } else if (G.state === 'paused') {
      G.state = 'playing'; el.pause.classList.add('hidden');
      // B01: only bring the banner back if its window has not expired
      if (G.bannerTimer > 0) el.banner.classList.remove('hidden');
    }
  }
  if (ev.code === 'KeyM') sfx.toggleMute();
  if (G.state === 'upgrade') {
    const idx = ['Digit1', 'Digit2', 'Digit3'].indexOf(ev.code);
    if (idx >= 0 && G.upgradeChoices[idx]) applyUpgrade(G.upgradeChoices[idx]);
  }
});
window.addEventListener('keyup', (ev) => { keys[ev.code] = false; });
window.addEventListener('mousemove', (ev) => {
  mouseNDC.x = (ev.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(ev.clientY / window.innerHeight) * 2 + 1;
});
window.addEventListener('mousedown', (ev) => {
  sfx.ensure();
  if (ev.button === 0) {
    if (G.state === 'title') { startGame(); return; }
    mouseDown = true;
  }
});
window.addEventListener('mouseup', (ev) => { if (ev.button === 0) mouseDown = false; });
$('restart-btn').addEventListener('click', () => startGame());
// camera-shake toggle (pause menu; persisted)
function syncShakeBtn() { el.shakeBtn.textContent = 'Camera shake: ' + (G.shakeOn ? 'ON' : 'OFF'); }
try { G.shakeOn = localStorage.getItem('gloamguard_shake') !== '0'; } catch {}
syncShakeBtn();
el.shakeBtn.addEventListener('click', () => {
  G.shakeOn = !G.shakeOn;
  try { localStorage.setItem('gloamguard_shake', G.shakeOn ? '1' : '0'); } catch {}
  syncShakeBtn();
});
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- camera ----------
const camTarget = new THREE.Vector3();
function updateCamera(dt) {
  if (G.state === 'title' || SHOT === 'start' || SHOT === 'end') {
    if (SHOT_MODE) {
      // fixed framing for the title / end captures: hero in clear view
      camera.position.set(7.5, 7, 13.5);
      camera.lookAt(0, 2.0, 0);
      return;
    }
    const a = G.time * 0.07;
    camTarget.set(Math.sin(a) * 3, 0, Math.cos(a) * 3);
    camera.position.lerp(new THREE.Vector3(Math.sin(a) * 11, 7.5, Math.cos(a) * 12.5), 1 - Math.pow(0.001, dt));
    camera.lookAt(0, 2.0, 0);
    return;
  }
  const want = new THREE.Vector3(player.pos.x * 0.55, 15.5, player.pos.z * 0.55 + 12.5);
  camera.position.lerp(want, 1 - Math.pow(0.0001, dt));
  const look = new THREE.Vector3(player.pos.x * 0.85, 0.8, player.pos.z * 0.85 - 1.5);
  if (G.shake > 0 && G.shakeOn) {
    look.x += (rand() - 0.5) * G.shake * 0.5;
    look.y += (rand() - 0.5) * G.shake * 0.3;
  }
  camera.lookAt(look);
}

// ---------- main update ----------
// B04: THREE.Clock is deprecated in r187 — THREE.Timer is the equivalent
// (update() then getDelta() in seconds; same wall-clock semantics, dt still
// capped at 0.05 below, so behaviour is unchanged).
const timer = new THREE.Timer();
function update(dt) {
  G.time += dt;
  // beam rotation (always, even on title — the arena is alive)
  G.beamAngle += (Math.PI * 2 / BEAM_PERIOD) * dt;
  G.beamOffset = (G.beamOffset ?? 0) + ((G.beamTarget ?? 0) - (G.beamOffset ?? 0)) * Math.min(1, dt * 6);
  const ang = G.beamAngle + (G.beamOffset ?? 0);
  for (let i = 0; i < BEAM_COUNT; i++) beamMeshes[i].rotation.y = ang + (i / BEAM_COUNT) * Math.PI * 2;
  // crystal pulse + rift pulse
  crystal.rotation.y += dt * 0.6;
  crystal.position.y = 4.6 + Math.sin(G.time * 1.4) * 0.12;
  crystal.material.emissiveIntensity = 1.5 + Math.sin(G.time * 2.2) * 0.35 + (G.core <= 2 ? -0.5 : 0);
  towerLight.intensity = 80 + Math.sin(G.time * 2.2) * 12;
  for (const r of rifts) {
    r.flash = Math.max(0, r.flash - dt * 1.4);
    r.ring.material.emissiveIntensity = 1.2 + r.flash * 2.5 + Math.sin(G.time * 2 + r.angle) * 0.3;
    r.glow.material.opacity = 0.14 + r.flash * 0.5 + Math.sin(G.time * 2 + r.angle) * 0.04;
    r.spawnRing.material.opacity = r.flash * 0.8;
    const s = 1 + r.flash * 0.6;
    r.spawnRing.scale.setScalar(s);
  }
  if (G.bannerTimer > 0) { G.bannerTimer -= dt; if (G.bannerTimer <= 0) el.banner.classList.add('hidden'); }
  if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 1.8);

  if (G.state === 'playing') {
    G.waveTime += dt;
    // spawning
    if (G.spawnQueue.length > 0) {
      G.spawnTimer -= dt;
      if (G.spawnTimer <= 0) {
        G.spawnTimer = 1.0;
        const type = G.spawnQueue.shift();
        const ri = Math.floor(rand() * rifts.length);
        rifts[ri].flash = 1;
        spawnEnemy(type, ri);
      }
    }
    // boss adds trickle
    if (G.wave === 5 && G.boss && !G.boss.dead) {
      G.bossAddsTimer -= dt;
      if (G.bossAddsTimer <= 0) {
        G.bossAddsTimer = 12;
        const adds = G.enemies.filter((e) => e.type !== 'boss').length;
        if (adds < 4) {
          const ri = Math.floor(rand() * rifts.length);
          rifts[ri].flash = 1;
          spawnEnemy('stalker', ri);
          spawnEnemy('stalker', (ri + 1) % 3);
        }
      }
      G.bossMotifTimer -= dt;
      if (G.bossMotifTimer <= 0) { G.bossMotifTimer = 9; sfx.bossMotif(Math.floor(rand() * 3)); }
    }
    updatePlayer(dt);
    for (const e of [...G.enemies]) updateEnemy(e, dt);
    G.enemies = G.enemies.filter((e) => !e.dead);
    updateBolts(dt);
    checkWaveClear();
    updateHUD();
  } else if (G.state === 'upgrade') {
    G.upgradeTimer -= dt;
    el.upgTimer.textContent = Math.max(0, Math.ceil(G.upgradeTimer));
    if (G.upgradeTimer <= 0 && G.upgradeChoices.length > 0) {
      applyUpgrade(G.upgradeChoices[Math.floor(rand() * G.upgradeChoices.length)]);
    }
  }
  updateParticles(dt);
  updateTelegraphs(dt);
  updateDmgNums(dt);
  for (const m of mixers) m.update(dt);
  updateCamera(dt);
}
function frame() {
  requestAnimationFrame(frame);
  timer.update();
  let dt = Math.min(timer.getDelta(), 0.05);
  if (G.hitStop > 0) { G.hitStop -= dt; dt = 0; }
  if (G.state !== 'paused') update(dt);
  renderer.render(scene, camera);
}

// ---------- init + deterministic shots ----------
function stepFrames(n) {
  for (let i = 0; i < n; i++) {
    update(1 / 60);
    renderer.render(scene, camera);
  }
}
function botInput() {
  // scripted stand-in for a player: circle-strafe + auto-fire at nearest foe
  const t = G.time;
  if (!botHold) {
    keys['KeyW'] = Math.sin(t * 0.9) > 0.2;
    keys['KeyS'] = Math.sin(t * 0.9) < -0.2;
    keys['KeyA'] = Math.cos(t * 0.9) > 0.2;
    keys['KeyD'] = Math.cos(t * 0.9) < -0.2;
  } else {
    keys['KeyW'] = keys['KeyS'] = keys['KeyA'] = keys['KeyD'] = false;
  }
  mouseDown = botFire;
  let best = null, bd = 1e9;
  for (const e of G.enemies) {
    if (e.dead) continue;
    const d = dist2d(e.obj.position, player.pos);
    if (d < bd) { bd = d; best = e; }
  }
  if (best) {
    botAim = new THREE.Vector3(best.obj.position.x - player.pos.x, 0, best.obj.position.z - player.pos.z).normalize();
  } else botAim = null;
}
async function init() {
  try {
    for (const [type, url] of Object.entries(MODELS)) {
      const gltf = await loader.loadAsync(url);
      templates[type] = { scene: gltf.scene, animations: gltf.animations };
    }
    // hero
    const hero = makeCharacter('knight');
    player.obj = hero.obj;
    player.mixer = hero.mixer;
    player.clips = hero.clips;
    player.current = null;
    player.obj.position.copy(player.pos);
    scene.add(player.obj);
    blobShadow(player.obj, 0.9);
    playClip(player, 'Idle');
    el.bestText.textContent = G.best.toLocaleString();

    if (SHOT_MODE) {
      await runShot();
      return;
    }
    updateHUD();
    frame();
  } catch (err) {
    console.error(err);
    window.__shotError = String(err?.message ?? err);
  }
}
async function runShot() {
  try {
    if (SHOT === 'start') {
      G.state = 'title';
      player.obj.position.set(0.5, 0, 7.5);
      player.pos.set(0.5, 0, 7.5);
      player.obj.rotation.y = 0.86;
      for (let i = 0; i < 3; i++) {
        const e = spawnEnemy('stalker', i % 3);
        const a = RIFT_ANGLES[i % 3] + (rand() - 0.5) * 0.4;
        e.obj.position.set(Math.sin(a) * 7, 0, Math.cos(a) * 7);
        e.obj.rotation.y = Math.atan2(-e.obj.position.x, -e.obj.position.z);
      }
      el.title.classList.remove('hidden');
      stepFrames(90);
    } else if (SHOT === 'play') {
      startGame();
      G.wave = 2;
      // clear the wave-1 queue, stage a mid-wave-2 fight
      G.spawnQueue = [];
      const spots = [[-4, -2], [5, -3], [-6, 4], [6, 5], [-1, -7], [3, 8]];
      const types = ['stalker', 'stalker', 'shooter', 'stalker', 'shooter', 'brute'];
      spots.forEach((s, i) => {
        const e = spawnEnemy(types[i], i % 3);
        e.obj.position.set(s[0], 0, s[1]);
        e.targetTower = false; // staged fight: all foes hunt the hero, mid-field
      });
      player.pos.set(-5, 0, 6);
      botHold = true;
      G.waveTime = 18;
      G.score = 850;
      // bot plays 4.5 s of combat
      for (let i = 0; i < 180; i++) {
        botInput(); update(1 / 60); renderer.render(scene, camera);
        // if the bot cleared the staged fight, restage it — the shot must stay in combat
        if (G.state !== 'playing') {
          el.upgrade.classList.add('hidden');
          el.banner.classList.add('hidden');
          G.state = 'playing';
          for (let k = 0; k < 2; k++) {
            const e = spawnEnemy(k === 0 ? 'shooter' : 'stalker', (i + k) % 3);
            e.obj.position.set(player.pos.x - 5 + k * 6, 0, player.pos.z - 5);
            e.targetTower = false;
          }
        }
      }
      botHold = false;
      updateHUD();
    } else if (SHOT === 'boss') {
      startGame();
      G.wave = 5;
      G.spawnQueue = [];
      G.score = 3200;
      G.core = 4;
      player.pos.set(-4, 0, 4);
      player.hp = 72;
      botHold = true;
      const boss = spawnEnemy('boss', 0);
      boss.obj.position.set(4, 0, 2);
      boss.attackCd = 2.5;
      const addSpots = [[-8, -7], [7, -7], [0, -9]];
      for (let i = 0; i < 3; i++) {
        const e = spawnEnemy('stalker', (i + 1) % 3);
        e.obj.position.set(addSpots[i][0], 0, addSpots[i][1]);
      }
      const realUpdate = update;
      for (let i = 0; i < 120; i++) { botInput(); realUpdate(1 / 60); renderer.render(scene, camera); }
      // re-arm the slam telegraph so it is visible in the capture
      if (G.boss && !G.boss.dead) {
        G.boss.windup = 1.0;
        showTelegraph(G.boss.obj.position, 4.6, 1.0);
        G.boss.attackCd = 99;
      }
      botFire = false; // stop shooting: let the boss hit-flash expire for a clean capture
      for (let i = 0; i < 30; i++) { botInput(); realUpdate(1 / 60); renderer.render(scene, camera); }
      botFire = true;
      botHold = false;
      updateHUD();
    } else if (SHOT === 'end') {
      startGame();
      G.wave = 5;
      G.spawnQueue = [];
      player.pos.set(0, 0, 5);
      G.score = 4750;
      G.core = 3;
      const e = spawnEnemy('stalker', 0);
      e.obj.position.set(-4, 0, -4);
      stepFrames(60);
      winGame();
      stepFrames(30);
    } else {
      stepFrames(60);
    }
    renderer.render(scene, camera);
    window.__shotReady = true;
  } catch (err) {
    console.error(err);
    window.__shotError = String(err?.message ?? err);
  }
}
init();
