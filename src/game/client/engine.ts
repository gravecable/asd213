import * as THREE from "three";
import {
  ARENA_RADIUS,
  BLOCK,
  BUFF_IDS,
  BUILD_REACH,
  CLOSE_BANNED,
  CLOSE_FULL,
  CLOSE_KICKED,
  CLOSE_OUTDATED,
  CLOSE_TOO_MANY,
  EYE_HEIGHT,
  GRAVITY,
  HIT_COOLDOWN_MS,
  HILL_RADIUS,
  HIT_REACH,
  HOT_STREAK,
  HUB,
  MAX_FALL_SPEED,
  MAX_HEIGHT,
  MOB_KINDS,
  MOB_LABELS,
  MODES,
  MODE_IDS,
  PLAYER_COLORS,
  PLAYER_HALF_WIDTH as HW,
  PLAYER_HEIGHT as PH,
  PROTOCOL_VERSION,
  SKIN_IDS,
  SPLEEF_LAYERS,
  SPRINT_TAP_MS,
  Voxels,
  WALK_SPEED,
  WS_PATH,
  buffModifiers,
  cellInRing,
  hubBlocks,
  inCellBox,
  inCircle,
  raycastVoxels,
  roundClock,
  stepBody,
} from "../shared";
import type { BagInfo, Body, BuffId, ClientMsg, GameMode, MobKind, PlayerInfo, ServerMsg, SkinId, VoxelHit } from "../shared";
import { Avatar } from "./avatar";
import { DamageNumbers, Explosions, Fireworks, Footprints, MeteorMarks, Particles } from "./effects";
import { HubScene } from "./hub-scene";
import { GeometryBuilder, applyFloorAo, buildBlockGeometry, buildFloor } from "./meshing";
import { Scenery } from "./scenery";
import { sfx } from "./sound";
import type { Spatial } from "./sound";
import type { SpecMode, Store, UiState } from "./store";
import { SWING_MS, createSwordModel, firstPersonMatrix, glintTime, setSwordStyle, swordStyle } from "./sword";
import type { SwordStyle } from "./sword";
import { createTextures, gridTexture, labelTexture, ringTexture, setLabelFont, setPixelFont } from "./textures";

/** Radians per mouse count at sensitivity 1×. */
const MOUSE_SENS = 0.0023;
const SENS_KEY = "pvp-sens";
export const SENS_MIN = 0.2;
export const SENS_MAX = 3;
const SEND_INTERVAL = 50;
const BREAK_REPEAT_MS = 220;
const PING_INTERVAL_MS = 2000;
const PLACE_REPEAT_MS = 200;
const DEATH_CAM_MS = 1600;
/** The reel stops a little before the buff lands so the result is readable. */
const ROULETTE_LEAD_MS = 350;
const BASE_FOV = 75;
const SKY = new THREE.Color("#8fc8ff");
/** Sky (top, horizon), light level, fog range and sun colour of each buff; in Chaos the first buff
 *  with a look wins. */
const BUFF_LOOKS: Partial<Record<BuffId, { top: string; horizon: string; light?: number; fog?: [number, number]; sun?: string }>> = {
  night: { top: "#03050f", horizon: "#121a38", light: 0.22, fog: [2, 26], sun: "#e6ecff" },
  lava: { top: "#3b0d0d", horizon: "#ff7a3d", light: 0.9 },
  meteors: { top: "#2a1a3a", horizon: "#ff9a4d", light: 0.85 },
  ice: { top: "#8fc1ff", horizon: "#e8f5ff" },
  oneshot: { top: "#4a0f14", horizon: "#e05a5a" },
  berserk: { top: "#3a0a0a", horizon: "#c24141", light: 0.9 },
  vampire: { top: "#2b0a1f", horizon: "#b03060", light: 0.8 },
  gravity: { top: "#1b2a6b", horizon: "#9ad0ff" },
  invisible: { top: "#4a5568", horizon: "#cbd5e1" },
  bounty: { top: "#5a3a06", horizon: "#ffd36b" },
  potato: { top: "#5a2306", horizon: "#ffb36b" },
  swap: { top: "#3a1a5a", horizon: "#e0b0ff" },
  giants: { top: "#0f4f4a", horizon: "#9ff3e6" },
  speed: { top: "#5a4a06", horizon: "#fff1a1" },
  baseball: { top: "#2a1f5a", horizon: "#c7b8ff" },
  doublejump: { top: "#0f4a2f", horizon: "#a7f3d0" },
  bows: { top: "#2f4a0f", horizon: "#d9f99d" },
  builder: { top: "#4a3216", horizon: "#f0d3a8" },
};
const BLOOD = ["#ef4444", "#b91c1c"];
const BONE_DUST = ["#f0ede0", "#d9d6c8", "#8d8979"];
const STARS = ["#fff7ae", "#ffde59", "#ffffff"];
const POOF = ["#ffffff", "#e5e5e5", "#d4d4d4"];
const DIRT_BITS = ["#79553a", "#966c4a", "#5d4128"];
const CRUMBLE_BITS = ["#79553a", "#966c4a", "#5d4128", "#6aa84f", "#8a8a8a"];
const EMBERS = ["#ff7a1a", "#ffb347", "#ff3b1f"];
const QUAD_UV = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** Island cells between two radii: what a crumble takes. */
function bandCells(outer: number, inner: number): [number, number][] {
  const out: [number, number][] = [];
  for (let x = -ARENA_RADIUS - 1; x <= ARENA_RADIUS; x++)
    for (let z = -ARENA_RADIUS - 1; z <= ARENA_RADIUS; z++) if (cellInRing(x, z, outer) && !cellInRing(x, z, inner)) out.push([x, z]);
  return out;
}
const LOOK_KEY = "pvp-look";
/** A little over the server's 300 ms limit on look changes. */
const LOOK_GAP_MS = 350;
/** Same limit as the server's duel invite check (horizontal distance). */
const DUEL_RANGE = 8;
const INVITE_MS = 15_000;
/** Matches the server's arrow physics (server/mobs.ts), for smooth flight between ticks. */
const ARROW_GRAVITY = 8;
const SKELETON = "#d9d6c8";
const MOB_LABEL_COLORS: Record<MobKind, string> = {
  dummy: "#e5e7eb",
  walker: "#f0ede0",
  cliff: "#fde047",
  archer: "#fca5a5",
  target: "#facc15",
};
/** Round start: everyone drops onto their spawn from this high during the countdown (visual only). */
const DROP_HEIGHT = 34;
const DROP_SHARE = 0.8;
/** Minecraft draws the hand with its own fixed 70° view, untouched by sprint or crit zoom. */
const HAND_FOV = 70;
/** The hand's lag behind the view, and view bobbing, ease like Minecraft's per-tick ×0.5 and ×0.4. */
const SWAY_RATE = 20 * Math.LN2;
const BOB_RATE = -20 * Math.log(0.6);
/** Minecraft moves mainHandHeight at most 0.4 per tick. */
const HAND_HEIGHT_RATE = 8;

/** Minecraft widens the view by 15% while sprinting and eases into it (half the gap per tick). */
const SPRINT_FOV = 1.15;
const FOV_EASE = 20 * Math.LN2;
/** A hit while sprinting slows the attacker down (Minecraft: ×0.6). */
const SPRINT_HIT_SLOW = 0.6;
/** Third-person camera: this far behind the eyes, pulled in by walls. */
const THIRD_PERSON_DIST = 4;
/** Particle colours kicked up by sprinting feet, by block type (index = BLOCK value). */
const DUST: string[][] = [
  ["#6bb03c", "#5f9e35", "#79553a"],
  ["#866043", "#79553a", "#5d4128"],
  ["#8a8a8a", "#6e6e6e", "#959595"],
  ["#a0784a", "#8a6339", "#b48a58"],
  ["#f5d442", "#e0b62b", "#fff0a0"],
  ["#2b1d3d", "#1a1226", "#3e2c58"],
  ["#9c4a3b", "#7f3a2e", "#b5b0a6"],
  ["#e8e4d0", "#cfcab3", "#f5f2e6"],
];
const LAVA_DUST = ["#ff7a00", "#ffb43d", "#e85d04"];

/** Fireworks over the pedestal for this long after the winner is back in the hub. */
const CELEBRATE_MS = 12_000;
const FIREWORK_COLORS = ["#ff4d6d", "#ffd166", "#06d6a0", "#4cc9f0", "#c77dff", "#ff9e00"];

type Mode = "orbit" | "frozen" | "play" | "spectate";
type Target = { id: number; t: number; mob: boolean };

function serverUrl() {
  const configured = process.env.NEXT_PUBLIC_GAME_SERVER_URL;
  if (configured) return configured;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${WS_PATH}`;
}

function reelItems(target: BuffId, count = 26): BuffId[] {
  const list: BuffId[] = [];
  while (list.length < count) {
    const b = BUFF_IDS[Math.floor(Math.random() * BUFF_IDS.length)];
    if (b === list[list.length - 1] || (list.length === count - 1 && b === target)) continue;
    list.push(b);
  }
  list.push(target);
  return list;
}

function closeReasonText(code: number, reason: string): string | null {
  switch (code) {
    case CLOSE_OUTDATED:
      return "Версия игры устарела — обновите страницу.";
    case CLOSE_KICKED:
      return `Вы отключены античитом${reason ? `: ${reason}` : ""}.`;
    case CLOSE_TOO_MANY:
      return "Слишком много подключений с вашего адреса.";
    case CLOSE_BANNED:
      return `Временный бан${reason ? `: ${reason}` : ""}.`;
    case CLOSE_FULL:
      return "Сервер переполнен, попробуйте позже.";
    default:
      return null;
  }
}

/** The look chosen in the wardrobe, or null before the player ever picked one (the server then
 *  hands out a free colour). */
function loadLook(): { color: string; skin: SkinId } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LOOK_KEY) ?? "null") as { color?: unknown; skin?: unknown } | null;
    if (raw && PLAYER_COLORS.includes(raw.color as string) && SKIN_IDS.includes(raw.skin as SkinId)) {
      return { color: raw.color as string, skin: raw.skin as SkinId };
    }
  } catch {
    // Private mode or a broken value: fall back to the server's choice.
  }
  return null;
}

function loadSens(): number {
  try {
    const v = Number(localStorage.getItem(SENS_KEY));
    if (v >= SENS_MIN && v <= SENS_MAX) return v;
  } catch {
    // No storage: default sensitivity.
  }
  return 1;
}

/** An arrow points along +Z, so `lookAt` turns it along its flight. */
function createArrow() {
  const g = new THREE.Group();
  const wood = new THREE.MeshLambertMaterial({ color: "#8a5a2b" });
  const tip = new THREE.MeshLambertMaterial({ color: "#9ca3af" });
  const feather = new THREE.MeshLambertMaterial({ color: "#f5f5f4" });
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.8), wood);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.14), tip);
  head.position.z = 0.44;
  const f1 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.02, 0.2), feather);
  f1.position.z = -0.34;
  const f2 = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.18, 0.2), feather);
  f2.position.z = -0.34;
  g.add(shaft, head, f1, f2);
  return g;
}

export class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.05, 400);
  private world = new Voxels();
  private tex = createTextures();
  private floor = buildFloor();
  /** Island radius the floor meshes were built for, and the meshes: top, stone ring, side, dirt. */
  private floorBuiltR = ARENA_RADIUS;
  private floorMeshes: THREE.Mesh[] = [];
  /** Cells about to crumble flash red. */
  private crumbleMat = new THREE.MeshBasicMaterial({ color: "#ff1a1a", transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  private crumbleMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.crumbleMat);
  private crumbleKey = "";
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private footprints = new Footprints();
  private meteorMarks = new MeteorMarks();
  private explosions = new Explosions();
  /** Invisible players' last footprint. */
  private stepAt = new Map<number, number>();
  private lavaTex: THREE.Texture;
  private lavaMesh: THREE.Mesh;
  private hillGroup = new THREE.Group();
  private hillMats: THREE.MeshBasicMaterial[] = [];
  private lastShotAt = 0;
  private bombTickAt = 0;
  private floorMat: THREE.MeshLambertMaterial;
  private blockMesh: THREE.Mesh;
  private blocksDirty = false;
  private floorAoDirty: "all" | [number, number][] = [];
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private ceiling: THREE.Mesh;
  private ceilingMat: THREE.MeshBasicMaterial;
  private highlight: THREE.LineSegments;
  /** The sword in hand: a scene of its own, drawn over the world with a fixed view. */
  private handScene = new THREE.Scene();
  private handCamera = new THREE.PerspectiveCamera(HAND_FOV, 1, 0.05, 10);
  private handSword: THREE.Group;
  private hand = { pitch: 0, yaw: 0, walk: 0, bob: 0, height: 1, matrix: new THREE.Matrix4() };
  private shakeRoll = 0;
  private clouds: THREE.InstancedMesh;
  private hubScene: HubScene;
  private scenery: Scenery;
  private fireworks = new Fireworks();
  private nextFirework = 0;
  private nextSparkle = 0;
  private particles = new Particles();
  private numbers = new DamageNumbers();
  private avatars = new Map<number, Avatar>();
  /** Hub skeletons (training mobs and range targets), keyed by mob id. */
  private mobs = new Map<number, Avatar>();
  private arrows = new Map<number, { group: THREE.Group; vel: THREE.Vector3 }>();
  private dying: Avatar[] = [];
  private bags = new Map<number, { info: BagInfo; group: THREE.Group }>();
  private ws: WebSocket | null = null;
  private name = "";
  private keys = new Set<string>();
  private mouse = { left: false, right: false };
  private resize: ResizeObserver;
  private raf = 0;
  private last = performance.now();
  private disposed = false;
  private pingTimer = 0;
  private pingSeq = 0;
  private pingSent = new Map<number, number>();
  private feedKey = 0;
  private uiKey = 0;
  private lastCue = "";
  /** A look change is on its way to the server: don't let an older roster undo it. */
  private lookPendingUntil = 0;
  private sens = loadSens();
  /** Last accepted mouse delta (size, event time) and the direction of a just-dropped outlier. */
  private mouseLast = { at: -1e9, mag: 0, dropped: 0 };
  private lookSentAt = -Infinity;
  private lookTimer = 0;
  private landed = true;
  // sprint (double-tap W) and view (V)
  private sprinting = false;
  /** Sprinted at some point since the last move was sent: that move must say so. */
  private sprintedSinceSend = false;
  private sprintTapAt = -1e9;
  private fovMod = 1;
  private dustAt = 0;
  private othersDustAt = 0;
  private thirdPerson = false;
  /** Our own model, drawn in third person. */
  private selfAvatar: Avatar | null = null;

  // local player
  private pos = new THREE.Vector3(HUB.spawn.x, 0, HUB.spawn.z);
  private vel = new THREE.Vector3();
  private body: Body = { pos: this.pos, vel: this.vel, onGround: false, jumpsLeft: 0, jumpHeld: false };
  private yaw = 0;
  private pitch = 0;
  /** Physics clock (sum of simulated dt, ms) reported with every move so the server can replay it. */
  private simTime = 0;
  /** Sequence number of the last server teleport, echoed back so stale moves get discarded. */
  private tpSeq = 0;
  /** Last knockback applied and last tick received, echoed back for the server's checks. */
  private kbSeq = 0;
  private lastTick = 0;
  private lastSend = 0;
  private sent = { ts: -1, yaw: 0, pitch: 0, sp: false };
  /** When other players last attacked; their avatar may only appear after the hit (invisibility). */
  private recentSwings = new Map<number, number>();
  private lastHitAt = 0;
  private lastBreakAt = 0;
  private lastPlaceAt = 0;
  /** The server spaces actions on the physics clock, which runs slower below 20 fps. */
  private actionSim = { hit: -Infinity, break: -Infinity, place: -Infinity };
  private swingAt = -1e9;
  private walkPhase = 0;

  // hit feedback
  private trauma = 0;
  private fovKick = 0;
  private hitStopUntil = 0;
  private deathAt = -1e9;
  private deathPos = new THREE.Vector3();
  private deathYaw = 0;
  private deathPitch = 0;

  // spectator / orbit camera
  private specMode: SpecMode = "third";
  private specTarget: number | null = null;
  private specPos = new THREE.Vector3(0, 24, 60);
  private specYaw = 0;
  private specPitch = -0.35;
  private orbitAngle = 0;
  private prevMode: Mode = "orbit";

  constructor(
    private container: HTMLElement,
    private store: Store<UiState>,
  ) {
    const style = getComputedStyle(container);
    setLabelFont(style.fontFamily);
    setPixelFont(style.getPropertyValue("--font-pixel"));
    const look = loadLook();
    this.store.set({ muted: sfx.muted, sens: this.sens, ...(look ? { look } : {}) });

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.camera);

    this.scene.background = SKY.clone();
    this.scene.fog = new THREE.Fog(SKY.clone(), 70, 190);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x7a6a50, 1.35);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.9);
    this.sun = sun;
    sun.position.set(30, 70, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -54;
    sc.right = 54;
    sc.top = 54;
    sc.bottom = -54;
    sc.near = 1;
    sc.far = 160;
    sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);
    this.scenery = new Scenery(sun.position);
    this.fireworks.onBurst = (at) => sfx.fireworkBurst(this.spatial(at));
    this.scene.add(this.scenery.group, this.fireworks.mesh);

    this.floorMat = new THREE.MeshLambertMaterial({ map: this.tex.grassTop, vertexColors: true });
    const top = new THREE.Mesh(this.floor.top, this.floorMat);
    const ringFloor = new THREE.Mesh(this.floor.ring, new THREE.MeshLambertMaterial({ map: this.tex.stone, vertexColors: true }));
    top.receiveShadow = ringFloor.receiveShadow = true;
    this.floorMeshes = [
      top,
      ringFloor,
      new THREE.Mesh(this.floor.side, new THREE.MeshLambertMaterial({ map: this.tex.grassSide })),
      new THREE.Mesh(this.floor.dirt, new THREE.MeshLambertMaterial({ map: this.tex.dirt })),
    ];
    this.scene.add(...this.floorMeshes);
    this.crumbleMesh.visible = false;
    this.scene.add(this.crumbleMesh);
    this.scene.add(this.footprints.mesh, this.meteorMarks.group, this.explosions.group);

    // Lava buff: the rising lava, one texture tile per block.
    this.lavaTex = this.tex.lava.clone();
    this.lavaTex.wrapS = this.lavaTex.wrapT = THREE.RepeatWrapping;
    this.lavaTex.repeat.set(ARENA_RADIUS * 2 + 1, ARENA_RADIUS * 2 + 1);
    this.lavaTex.needsUpdate = true;
    this.lavaMesh = new THREE.Mesh(
      new THREE.CircleGeometry(ARENA_RADIUS + 0.5, 96).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ map: this.lavaTex, emissive: "#c2410c", emissiveIntensity: 0.9, transparent: true, opacity: 0.9 }),
    );
    this.lavaMesh.visible = false;
    this.scene.add(this.lavaMesh);

    // King of the Hill: the hill's ring, its floor and a beacon in the holder's colour.
    // The beacon shows from outside only: seen from within it would tint half the screen.
    const flat = (g: THREE.BufferGeometry, opacity: number, side: THREE.Side = THREE.DoubleSide) => {
      const m = new THREE.MeshBasicMaterial({ color: "#fbbf24", transparent: true, opacity, depthWrite: false, side, fog: false });
      this.hillMats.push(m);
      return new THREE.Mesh(g, m);
    };
    this.hillGroup.add(
      flat(new THREE.RingGeometry(HILL_RADIUS - 0.3, HILL_RADIUS, 64).rotateX(-Math.PI / 2).translate(0, 0.04, 0), 0.9),
      flat(new THREE.CircleGeometry(HILL_RADIUS - 0.3, 64).rotateX(-Math.PI / 2).translate(0, 0.03, 0), 0.18),
      flat(new THREE.CylinderGeometry(HILL_RADIUS, HILL_RADIUS, 40, 48, 1, true).translate(0, 20, 0), 0.08, THREE.FrontSide),
    );
    this.hillGroup.visible = false;
    this.scene.add(this.hillGroup);

    this.blockMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ map: this.tex.blockAtlas, vertexColors: true }));
    this.blockMesh.castShadow = this.blockMesh.receiveShadow = true;
    this.scene.add(this.blockMesh);

    const rt = ringTexture();
    rt.repeat.set(96, 1);
    this.ringMat = new THREE.MeshBasicMaterial({ map: rt, color: "#9fe8ff", transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false });
    this.ring = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, MAX_HEIGHT + 1, 128, 1, true), this.ringMat);
    this.ring.position.y = MAX_HEIGHT / 2 - 0.5;
    this.scene.add(this.ring);

    const gt = gridTexture();
    gt.repeat.set(ARENA_RADIUS * 2, ARENA_RADIUS * 2);
    this.ceilingMat = new THREE.MeshBasicMaterial({ map: gt, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    this.ceiling = new THREE.Mesh(new THREE.CircleGeometry(ARENA_RADIUS, 96), this.ceilingMat);
    this.ceiling.rotation.x = Math.PI / 2;
    this.ceiling.position.y = MAX_HEIGHT;
    this.scene.add(this.ceiling);

    this.hubScene = new HubScene({ label: style.fontFamily, pixel: style.getPropertyValue("--font-pixel") });
    this.scene.add(this.hubScene.group);
    // The hub layout is shared code: show it behind the join screen before the server sends it.
    const q = hubBlocks();
    for (let i = 0; i < q.length; i += 4) this.world.set(q[i], q[i + 1], q[i + 2], q[i + 3]);
    this.floorAoDirty = "all";
    this.blocksDirty = true;

    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 }),
    );
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    this.handScene.add(new THREE.HemisphereLight(0xffffff, 0x7a6a50, 1.5));
    const handLight = new THREE.DirectionalLight(0xfff4e0, 1.3);
    handLight.position.set(-0.4, 1, 0.7);
    this.handScene.add(handLight);
    this.handSword = this.buildHandSword();

    this.clouds = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, fog: false }),
      26,
    );
    const d = new THREE.Object3D();
    for (let i = 0; i < 26; i++) {
      d.position.set((Math.random() - 0.5) * 260, 48 + Math.random() * 10, (Math.random() - 0.5) * 260);
      d.scale.set(10 + Math.random() * 24, 2, 8 + Math.random() * 16);
      d.updateMatrix();
      this.clouds.setMatrixAt(i, d.matrix);
    }
    this.scene.add(this.clouds, this.particles.mesh, this.numbers.group);

    this.resize = new ResizeObserver(() => this.onResize());
    this.resize.observe(container);
    this.onResize();

    const el = this.renderer.domElement;
    el.addEventListener("mousedown", this.onMouseDown);
    el.addEventListener("contextmenu", this.preventDefault);
    el.addEventListener("wheel", this.onWheel, { passive: true });
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("pointerlockchange", this.onLockChange);

    this.raf = requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------------ public API

  join(name: string) {
    sfx.unlock();
    this.name = name;
    this.connect();
  }

  reconnect() {
    sfx.unlock();
    if (this.name) this.connect();
  }

  /** Wardrobe pick: saved locally, sent to the server, shown to everyone with the next roster. */
  setLook(color: string, skin: SkinId) {
    if (!PLAYER_COLORS.includes(color) || !SKIN_IDS.includes(skin)) return;
    const look = { color, skin };
    this.store.set({ look });
    this.lookPendingUntil = performance.now() + 2000;
    try {
      localStorage.setItem(LOOK_KEY, JSON.stringify(look));
    } catch {
      // Not persisted (private mode); the server still gets it.
    }
    this.flushLook();
  }

  /** The server takes one look change per 300 ms and drops the rest: quick clicks are coalesced and
   *  the latest pick is sent once the gap has passed. */
  private flushLook = () => {
    window.clearTimeout(this.lookTimer);
    const wait = this.lookSentAt + LOOK_GAP_MS - performance.now();
    if (wait > 0) {
      this.lookTimer = window.setTimeout(this.flushLook, wait);
      return;
    }
    this.lookSentAt = performance.now();
    const { color, skin } = this.store.get().look;
    this.send({ t: "look", color, skin });
  };

  /** Mouse sensitivity multiplier, saved in the browser. */
  setSens(v: number) {
    if (!Number.isFinite(v)) return;
    this.sens = Math.round(Math.max(SENS_MIN, Math.min(SENS_MAX, v)) * 100) / 100;
    this.store.set({ sens: this.sens });
    try {
      localStorage.setItem(SENS_KEY, String(this.sens));
    } catch {
      // Kept for this session only.
    }
  }

  setWardrobe(open: boolean) {
    this.setOverlay({ wardrobe: open, ...(open ? { help: false } : {}) });
  }

  setHelp(open: boolean) {
    this.setOverlay({ help: open, ...(open ? { wardrobe: false } : {}) });
  }

  answerDuel(accept: boolean) {
    if (!this.store.get().invite) return;
    this.store.set({ invite: null });
    this.send({ t: "duelAnswer", accept });
  }

  /** T: from the hub into the arena as a spectator, and back. */
  toggleWatch() {
    const s = this.store.get();
    if (s.watching || (s.view === "arena" && !s.alive)) this.send({ t: "watch", on: false });
    else if (s.view === "hub" && s.phase !== "lobby" && !this.inDuel()) this.send({ t: "watch", on: true });
  }

  toggleMute() {
    sfx.unlock();
    sfx.setMuted(!sfx.muted);
    this.store.set({ muted: sfx.muted });
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.lookTimer);
    this.stopPing();
    this.resize.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener("mousedown", this.onMouseDown);
    el.removeEventListener("contextmenu", this.preventDefault);
    el.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    if (document.pointerLockElement === el) document.exitPointerLock();
    this.ws?.close();
    this.ws = null;
    this.clearWorldObjects();
    this.dropSelfAvatar();
    this.disposeGroup(this.handSword);
    this.hubScene.dispose();
    this.numbers.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m: THREE.Material & { map?: THREE.Texture | null }) => {
          m.map?.dispose();
          m.dispose();
        });
      }
    });
    this.renderer.dispose();
    el.remove();
  }

  // ------------------------------------------------------------------ networking

  private connect() {
    this.ws?.close();
    this.store.set({ conn: "connecting", closeReason: null });
    let ws: WebSocket;
    try {
      ws = new WebSocket(serverUrl());
    } catch {
      this.store.set({ conn: "closed" });
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.store.set({ conn: "open" });
      // Only a look the player picked is sent; otherwise the server hands out a free colour.
      const look = loadLook();
      ws.send(JSON.stringify({ t: "hello", name: this.name, v: PROTOCOL_VERSION, ...(look ?? {}) } satisfies ClientMsg));
      this.startPing();
    };
    ws.onmessage = (e) => {
      if (this.ws === ws) this.onMessage(JSON.parse(e.data) as ServerMsg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws || this.disposed) return;
      this.ws = null;
      this.stopPing();
      this.store.set({
        conn: "closed",
        closeReason: closeReasonText(e.code, e.reason),
        myId: null,
        alive: false,
        ping: null,
        watching: false,
        wardrobe: false,
        help: false,
        invite: null,
        duel: null,
        duelTarget: null,
        nearWardrobe: false,
      });
      this.clearWorldObjects();
      if (document.pointerLockElement) document.exitPointerLock();
    };
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private startPing() {
    this.stopPing();
    const ping = () => {
      const now = performance.now();
      for (const [id, at] of this.pingSent) if (now - at > 10_000) this.pingSent.delete(id);
      this.pingSent.set(++this.pingSeq, now);
      this.send({ t: "ping", id: this.pingSeq });
    };
    ping();
    this.pingTimer = window.setInterval(ping, PING_INTERVAL_MS);
  }

  private stopPing() {
    window.clearInterval(this.pingTimer);
    this.pingSent.clear();
  }

  private sendMove(now: number) {
    this.lastSend = now;
    const sp = this.sprinting || this.sprintedSinceSend;
    this.sprintedSinceSend = false;
    this.sent = { ts: this.simTime, yaw: this.yaw, pitch: this.pitch, sp };
    const p = this.pos;
    this.send({
      t: "move",
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: this.yaw,
      pitch: this.pitch,
      vy: this.vel.y,
      ts: this.simTime,
      n: this.tpSeq,
      k: this.kbSeq,
      tk: this.lastTick,
      sp,
    });
  }

  /** The server checks actions against the last reported position, view and sprint, so report them first. */
  private flushMove() {
    const s = this.sent;
    const sp = this.sprinting || this.sprintedSinceSend;
    if (s.ts !== this.simTime || s.yaw !== this.yaw || s.pitch !== this.pitch || s.sp !== sp) this.sendMove(performance.now());
  }

  /** Volume falls off with distance; pan follows the camera's left/right. */
  private spatial(p: THREE.Vector3): Spatial {
    const cam = this.camera.position;
    const dx = p.x - cam.x;
    const dz = p.z - cam.z;
    const dist = Math.hypot(dx, p.y - cam.y, dz);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const pan = dist > 0.5 ? (dx * right.x + dz * right.z) / dist : 0;
    return { vol: 1 / (1 + dist * 0.12), pan: pan * 0.8 };
  }

  private onMessage(m: ServerMsg) {
    const now = performance.now();
    switch (m.t) {
      case "welcome":
        this.store.set({ myId: m.id });
        break;
      case "roster": {
        const s = this.store.get();
        const me = m.players.find((p) => p.id === s.myId);
        const syncLook = me && now > this.lookPendingUntil && (me.color !== s.look.color || me.skin !== s.look.skin);
        this.store.set({ players: m.players, ...(syncLook ? { look: { color: me.color, skin: me.skin } } : {}) });
        const byId = new Map(m.players.map((p) => [p.id, p]));
        const self = this.selfAvatar;
        if (self && (!me || me.skin !== self.skin || me.color !== self.color)) this.dropSelfAvatar();
        else if (self && me) self.setCrown(me.crown);
        for (const [id, a] of this.avatars) {
          const info = byId.get(id);
          // A new look needs a new model: the next tick builds it.
          if (!info || info.skin !== a.skin || info.color !== a.color) this.removeAvatar(id);
          else a.setCrown(info.crown);
        }
        break;
      }
      case "phase": {
        const prev = this.store.get().phase;
        this.store.set({
          phase: m.phase,
          phaseStartedAt: now - m.elapsed,
          timings: m.timings,
          buffs: m.buffs,
          winTeam: m.winTeam,
          mode: m.mode,
          winnerId: m.winner,
          winnerName: m.winnerName,
          pointsWin: m.pointsWin,
          floor: m.floor,
          ...(m.phase === "countdown" ? { feed: [], announce: null, death: null, callout: null, lava: -1, bounty: null, bomb: null, score: null } : {}),
          ...(m.phase !== "playing" ? { roulette: null, crumble: null, vote: null } : {}),
        });
        if (m.phase === "countdown") this.landed = false;
        this.refreshVisuals();
        const inArena = this.store.get().view === "arena";
        if (m.phase === "ended" && prev !== "ended" && inArena) sfx.roundEnd(m.winner !== null && m.winner === this.store.get().myId);
        // The end screen needs the mouse; the hub keeps playing through phase changes.
        if (m.phase === "ended" && prev !== m.phase && inArena && document.pointerLockElement) document.exitPointerLock();
        break;
      }
      case "roulette": {
        const duration = Math.max(1000, m.ms - ROULETTE_LEAD_MS);
        this.store.set({ roulette: { key: ++this.uiKey, items: reelItems(m.buffs[0]), endsAt: now + duration, duration } });
        break;
      }
      case "buff":
        this.store.set({ buffs: m.buffs, roulette: null, announce: m.buffs.length ? { buffs: m.buffs, key: ++this.uiKey, at: now } : null });
        this.refreshVisuals();
        if (this.store.get().view === "arena" && m.buffs.length) {
          if (m.buffs.length > 1) sfx.chaos();
          else sfx.buff(m.buffs[0]);
        }
        break;
      case "world":
        this.enterWorld(m.w, m.blocks);
        break;
      case "floor":
        this.onFloor(m, now);
        break;
      case "callout":
        this.store.set({ callout: { key: ++this.uiKey, text: m.text, sub: m.sub, color: m.color, at: now } });
        if (m.text === "ОБМЕН") sfx.swapWarn();
        else if (m.text === "ОБМЕН!") sfx.swap();
        else sfx.callout();
        break;
      case "lava": {
        const prev = this.store.get().lava;
        this.store.set({ lava: m.y });
        if (m.y > 0 && m.y > prev && this.store.get().view === "arena") sfx.lavaRise();
        break;
      }
      case "bounty":
        this.store.set({ bounty: m.id });
        break;
      case "bomb": {
        const st = this.store.get();
        const prev = st.bomb;
        this.store.set({ bomb: m.holder === null ? null : { holder: m.holder, endsAt: now + m.ms, total: Math.max(m.ms, prev?.total ?? st.timings.bombMs) } });
        if (prev && m.holder !== null && prev.holder !== m.holder) sfx.bombPass(this.spatialOf(m.holder));
        break;
      }
      case "meteor":
        this.meteorMarks.warn(m.id, m.x, m.y, m.z, m.r, now + m.ms);
        sfx.meteorWhoosh(this.spatial(new THREE.Vector3(m.x, m.y, m.z)));
        break;
      case "boom": {
        const at = new THREE.Vector3(m.x, m.y, m.z);
        this.meteorMarks.update(now);
        this.explosions.spawn(m.x, m.y - (m.kind === "bomb" ? 0.9 : 0.3), m.z, m.r, now);
        this.particles.burst(at, EMBERS, 30, 9, 0.18);
        this.particles.burst(at, POOF, 16, 4, 0.25);
        sfx.boom(this.spatial(at));
        this.trauma = Math.min(1, this.trauma + Math.max(0, 0.8 - at.distanceTo(this.camera.position) / 25));
        break;
      }
      case "score":
        this.store.set({ score: { teams: m.teams, target: m.target, hill: m.hill, contested: m.contested } });
        if (m.hill !== null && m.hill === this.store.get().myId) sfx.point();
        break;
      case "buffVote":
        this.store.set({ vote: m.options.length ? { options: m.options, votes: m.votes, endsAt: now + m.ms, mine: m.mine } : null });
        break;
      case "block": {
        if (m.w !== this.store.get().view) break;
        this.world.set(m.x, m.y, m.z, m.v);
        if (m.y === 0 && this.floorAoDirty !== "all") this.floorAoDirty.push([m.x, m.z]);
        this.blocksDirty = true;
        const at = new THREE.Vector3(m.x + 0.5, m.y + 0.5, m.z + 0.5);
        if (m.v) {
          sfx.place(this.spatial(at));
        } else {
          this.particles.burst(at, DIRT_BITS, 14, 5);
          sfx.breakBlock(this.spatial(at));
        }
        break;
      }
      case "tick":
        this.lastTick = m.s;
        this.onTick(m.p);
        this.syncMobs(m.m ?? [], now);
        this.syncArrows(m.a ?? [], now);
        break;
      case "you": {
        const s = this.store.get();
        if (s.view === "arena" && s.alive && !m.alive) {
          this.specPos.copy(this.camera.position);
          // Fell off the island: watch from above it, not from under it.
          if (this.specPos.y < 0) this.specPos.y = 6;
          this.specYaw = this.yaw;
          this.specPitch = this.pitch;
        }
        if (s.alive && m.alive && m.dirt >= s.dirt + 2) sfx.pickup();
        if (s.view === "arena" && s.phase === "playing" && !s.alive && m.alive) sfx.respawn();
        this.store.set({
          hp: m.hp,
          maxHp: m.maxHp,
          dirt: m.dirt,
          arrows: m.arrows,
          alive: m.alive,
          role: m.role,
          watching: m.watching,
          respawnAt: m.respawnIn ? now + m.respawnIn : 0,
        });
        break;
      }
      case "tp":
        this.tpSeq = m.n;
        this.pos.set(m.x, m.y, m.z);
        this.vel.set(0, 0, 0);
        this.body.onGround = false;
        if (m.yaw !== undefined) {
          this.yaw = m.yaw;
          this.pitch = 0;
        }
        // Report the new spot right away: it anchors the server's replay of our physics.
        this.sendMove(now);
        break;
      case "hurt":
        this.onHurt(m, now);
        break;
      case "kill":
        this.onKill(m, now);
        break;
      case "bags":
        this.syncBags(m.bags);
        break;
      case "pong": {
        const at = this.pingSent.get(m.id);
        if (at === undefined) break;
        this.pingSent.delete(m.id);
        this.store.set({ ping: Math.round(now - at) });
        break;
      }
      case "hub": {
        const votes = Object.fromEntries(MODE_IDS.map((id, i) => [id, m.votes[i] ?? 0])) as Record<GameMode, number>;
        this.store.set({
          hub: { startAt: m.startIn === null ? null : now + m.startIn, ready: m.ready, active: m.active, need: m.need, votes, myVote: m.myVote, inRound: m.inRound },
        });
        break;
      }
      case "train":
        this.store.set({ train: m.s });
        break;
      case "hint":
        this.store.set({ hint: { key: ++this.uiKey, text: m.text, at: now } });
        break;
      case "range": {
        const prev = this.store.get().range?.state;
        this.store.set({ range: { state: m.state, endsAt: now + m.ms, score: m.score, best: m.best, at: now } });
        if (m.state === "running" && prev !== "running") sfx.beep(true);
        if (m.state === "done") sfx.roundEnd(m.score > 0 && m.score >= m.best);
        break;
      }
      case "parkour": {
        this.store.set({ parkour: { state: m.state, startedAt: now - (m.state === "running" ? m.ms : 0), time: m.ms, best: m.best, at: now } });
        if (m.state === "done") sfx.roundEnd(m.best === null || m.ms <= m.best);
        break;
      }
      case "duelInvite":
        this.store.set({ invite: { from: m.from, at: now } });
        sfx.beep(false);
        break;
      case "duel":
        if (m.state === "none") {
          this.store.set({ duel: null });
          break;
        }
        this.store.set({ duel: { state: m.state, opponent: m.opponent, endsAt: now + m.ms, won: m.won, at: now }, invite: null, wardrobe: false, help: false });
        if (m.state === "fight") sfx.beep(true);
        if (m.state === "over") sfx.roundEnd(m.won === true);
        break;
      case "arrowHit":
        this.store.set((st) => ({ arrowKey: st.arrowKey + 1 }));
        this.trauma = Math.min(1, this.trauma + 0.2);
        sfx.hurt();
        break;
      case "records":
        this.store.set({ records: m.r });
        break;
      case "results":
        this.store.set({ results: m.r });
        break;
      case "notice":
        this.store.set((st) => ({ notices: [...st.notices.slice(-5), { key: ++this.uiKey, at: now, text: m.text, color: m.color }] }));
        break;
    }
  }

  /** The arena's island: a warning marks the cells about to fall, then they fall with every block on them. */
  private onFloor(m: Extract<ServerMsg, { t: "floor" }>, now: number) {
    if (m.next !== null) {
      this.store.set({ crumble: { next: m.next, at: now + m.ms } });
      return;
    }
    const s = this.store.get();
    const prev = s.floor;
    this.store.set({ floor: m.r, crumble: null });
    if (s.view !== "arena" || m.r >= prev) return;
    for (const i of [...this.world.filled]) {
      const [x, y, z] = Voxels.decode(i);
      if (!cellInRing(x, z, m.r)) this.world.set(x, y, z, 0);
    }
    this.blocksDirty = true;
    this.floorAoDirty = "all";
    // Debris over a sample of the fallen cells, a rumble and a shake.
    const band = bandCells(prev, m.r);
    let nearest: THREE.Vector3 | null = null;
    for (let n = 0; n < 30 && band.length; n++) {
      const [x, z] = band.splice(Math.floor(Math.random() * band.length), 1)[0];
      const at = new THREE.Vector3(x + 0.5, -0.2, z + 0.5);
      this.particles.burst(at, CRUMBLE_BITS, 8, 5, 0.16);
      if (!nearest || at.distanceToSquared(this.camera.position) < nearest.distanceToSquared(this.camera.position)) nearest = at;
    }
    if (nearest) sfx.breakBlock(this.spatial(nearest));
    sfx.land(30);
    this.trauma = Math.min(1, this.trauma + 0.4);
  }

  /** Rising lava, the hill, the players' looks (size, team, zombie, bounty, bomb, night labels)
   *  and the buff effects. */
  private syncRoundFx(t: number) {
    const s = this.store.get();
    const arena = s.view === "arena";
    const live = arena && s.phase === "playing";
    const lava = live ? s.lava : -1;
    this.lavaMesh.visible = lava >= 1;
    if (lava >= 1) {
      this.lavaMesh.position.y = lava + 0.1;
      this.lavaTex.offset.set((t / 1000) * 0.02, (t / 1000) * 0.013);
    }
    const koth = arena && s.mode === "koth" && s.phase !== "lobby";
    this.hillGroup.visible = koth;
    if (koth) {
      const holder = s.score?.hill != null ? s.players.find((p) => p.id === s.score?.hill) : undefined;
      const color = s.score?.contested ? "#ef4444" : (holder?.color ?? "#fbbf24");
      const pulse = 0.75 + 0.25 * Math.sin(t / 220);
      this.hillMats.forEach((m, i) => {
        m.color.set(color);
        m.opacity = [0.9, 0.18, 0.08][i] * (holder || s.score?.contested ? pulse * 1.4 : 1);
      });
    }
    const night = live && s.buffs.includes("night");
    for (const a of this.avatars.values()) this.applyLook(a, s, live, night, t);
    if (this.selfAvatar) this.applyLook(this.selfAvatar, s, live, false, t);
    this.footprints.update(t);
    this.meteorMarks.update(t);
    this.explosions.update(t);
  }

  private applyLook(a: Avatar, s: UiState, live: boolean, night: boolean, t: number) {
    const info = s.players.find((p) => p.id === a.id);
    const arena = s.view === "arena";
    const teams = arena ? MODES[s.mode].teams : null;
    a.setScale(arena && info ? info.size : 1);
    a.setZombie(arena && s.mode === "infection" && info?.team === 1);
    if (info) a.setLabelColor(teams && info.team !== null ? teams[info.team].color : info.color);
    a.setMarked(live && s.bounty === a.id);
    const bomb = live && s.bomb?.holder === a.id ? s.bomb : null;
    a.setBomb(!!bomb, bomb ? Math.max(0, Math.min(1, (bomb.endsAt - t) / bomb.total)) : 1);
    a.setLabelOnTop(night);
  }

  /** Invisible players leave footprints where they run. */
  private trackFootprints(t: number) {
    for (const a of this.avatars.values()) {
      if (a.moveSpeed < 1.5) continue;
      const y = Math.round(a.pos.y);
      if (Math.abs(a.pos.y - y) > 0.06 || !this.world.solid(Math.floor(a.pos.x), y - 1, Math.floor(a.pos.z))) continue;
      if (t - (this.stepAt.get(a.id) ?? 0) < 260) continue;
      this.stepAt.set(a.id, t);
      this.footprints.add(a.pos.x, y, a.pos.z, a.group.rotation.y, t);
    }
  }

  /** The bomb's fuse ticks for its holder, and for everyone in the last seconds. */
  private updateBombTick(t: number) {
    const s = this.store.get();
    const b = s.view === "arena" && s.phase === "playing" ? s.bomb : null;
    if (!b) return;
    const urgent = b.endsAt - t < 5000;
    if (t - this.bombTickAt < (urgent ? 250 : 1000)) return;
    this.bombTickAt = t;
    if (b.holder === s.myId || urgent) sfx.bombTick(urgent);
  }

  /** Floor meshes, rock and physics follow the arena's crumbling island; the hub stands on the whole
   *  one, inside its wall. The cells of the next crumble flash, faster as it nears. */
  private syncIsland(t: number) {
    const s = this.store.get();
    const arena = s.view === "arena";
    const spleef = arena && s.mode === "spleef";
    const island = arena ? s.floor : ARENA_RADIUS;
    this.world.floorRadius = arena ? (spleef ? 0 : s.floor) : Infinity;
    const r = spleef ? 0 : island;
    if (r !== this.floorBuiltR) {
      this.floorBuiltR = r;
      const old = this.floor;
      this.floor = buildFloor(r);
      const [top, ring, side, dirt] = this.floorMeshes;
      top.geometry = this.floor.top;
      ring.geometry = this.floor.ring;
      side.geometry = this.floor.side;
      dirt.geometry = this.floor.dirt;
      for (const g of [old.top, old.ring, old.side, old.dirt]) g.dispose();
      this.scenery.setIslandRadius(r);
      this.floorAoDirty = "all";
      this.blocksDirty = true;
    }
    const c = arena && s.phase === "playing" ? s.crumble : null;
    const key = c ? `${island}>${c.next}>${spleef}` : "";
    if (key !== this.crumbleKey) {
      this.crumbleKey = key;
      const g = new GeometryBuilder();
      for (const [x, z] of c ? bandCells(island, c.next) : []) {
        const y = spleef ? SPLEEF_LAYERS[1] + 1.02 : 0.02;
        g.quad(
          [
            [x, y, z + 1],
            [x + 1, y, z + 1],
            [x + 1, y, z],
            [x, y, z],
          ],
          [0, 1, 0],
          QUAD_UV,
          null,
        );
      }
      this.crumbleMesh.geometry.dispose();
      this.crumbleMesh.geometry = g.build();
    }
    this.crumbleMesh.visible = !!c;
    if (c) this.crumbleMat.opacity = 0.4 + 0.4 * (0.5 + 0.5 * Math.sin(t / (c.at - t < 3000 ? 60 : 150)));
  }

  /** The server moved us into another world (hub ↔ arena): start from a clean scene. */
  private enterWorld(w: UiState["view"], blocks: number[]) {
    this.clearWorldObjects();
    this.world.clear();
    for (let i = 0; i + 3 < blocks.length; i += 4) this.world.set(blocks[i], blocks[i + 1], blocks[i + 2], blocks[i + 3]);
    this.floorAoDirty = "all";
    this.blocksDirty = true;
    this.fireworks.clear();
    this.meteorMarks.clear();
    this.explosions.clear();
    this.footprints.clear();
    this.stepAt.clear();
    this.deathAt = -1e9;
    this.specTarget = null;
    this.trauma = 0;
    this.sprinting = false;
    // Into a new world with the sword lowered: it comes up like a freshly drawn item.
    this.hand.height = 0;
    this.store.set(
      w === "hub"
        ? { view: w, spectate: null, death: null, lava: -1, bounty: null, bomb: null, score: null, vote: null }
        : { view: w, wardrobe: false, help: false, nearWardrobe: false, duelTarget: null, invite: null, lava: -1, bounty: null, bomb: null, vote: null },
    );
    this.refreshVisuals();
  }

  /** Removes everyone and everything that lives in the current world. */
  private clearWorldObjects() {
    for (const id of [...this.avatars.keys()]) this.removeAvatar(id);
    for (const a of this.mobs.values()) this.dropModel(a);
    this.mobs.clear();
    for (const a of this.dying) this.dropModel(a);
    this.dying = [];
    for (const a of this.arrows.values()) this.disposeGroup(a.group);
    this.arrows.clear();
    this.syncBags([]);
    this.recentSwings.clear();
  }

  private dropModel(a: Avatar) {
    this.scene.remove(a.group);
    a.dispose();
  }

  private disposeGroup(group: THREE.Object3D) {
    this.scene.remove(group);
    group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        o.geometry.dispose();
        (o.material as THREE.MeshBasicMaterial).map?.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }

  private setOverlay(patch: Partial<Pick<UiState, "wardrobe" | "help">>) {
    this.store.set(patch);
    const s = this.store.get();
    if (s.wardrobe || s.help) {
      this.keys.clear();
      this.mouse.left = this.mouse.right = false;
      if (document.pointerLockElement) document.exitPointerLock();
    }
  }

  private inDuel() {
    const d = this.store.get().duel;
    return !!d && (d.state === "countdown" || d.state === "fight");
  }

  private onHurt(m: Extract<ServerMsg, { t: "hurt" }>, now: number) {
    const s = this.store.get();
    const mine = m.by !== 0 && m.by === s.myId;
    const toMe = m.id === s.myId;
    const victim = this.avatars.get(m.id) ?? this.mobs.get(m.id);
    if (victim?.mob) victim.setHp(Math.max(0, m.hp));
    if (toMe) {
      if (m.kn) this.kbSeq = m.kn;
      this.vel.x += m.kx;
      this.vel.z += m.kz;
      if (m.ky) this.vel.y = Math.max(this.vel.y, m.ky);
      this.trauma = Math.min(1, this.trauma + (m.by ? 0.55 : 0.25));
      this.selfAvatar?.hurt(now);
      this.store.set({ hurtKey: s.hurtKey + 1 });
      sfx.hurt();
    }
    victim?.hurt(now);
    // An arrow landing isn't a swing of its shooter.
    if (m.by && !mine && !m.arrow) {
      this.recentSwings.set(m.by, now);
      this.avatars.get(m.by)?.swing(now);
    }
    const at = victim ? victim.pos.clone() : toMe ? this.pos.clone() : null;
    if (!at) return;
    at.y += 1.2;
    const bits = victim?.mob ? BONE_DUST : BLOOD;
    this.particles.burst(at, bits, m.by ? 8 : 4, 4);
    if (m.crit) this.particles.burst(at, STARS, 18, 6, 0.12);
    if (victim) {
      const color = !m.by ? "#ff9f1c" : mine ? (m.crit ? "#ff8c1a" : "#ffde59") : m.crit ? "#ffc266" : "#ffffff";
      this.numbers.spawn(victim.pos.clone().setY(victim.pos.y + 2.45), `-${m.dmg}${m.crit ? "!" : ""}`, color, mine || m.crit, now);
    }
    if (m.arrow) {
      sfx.arrowHit(toMe ? undefined : this.spatial(at));
    } else if (mine) {
      // Hit-stop: freeze the world for a few frames so the hit lands with weight.
      this.hitStopUntil = now + (m.crit ? 120 : 70);
      this.trauma = Math.min(1, this.trauma + (m.crit ? 0.4 : 0.22));
      if (m.crit) this.fovKick = 7;
      sfx.hit(m.crit);
    } else if (!toMe && m.by) {
      sfx.hit(m.crit, this.spatial(at));
    }
  }

  private onKill(m: Extract<ServerMsg, { t: "kill" }>, now: number) {
    const s = this.store.get();
    const find = (id: number | null) => (id === null ? null : s.players.find((p) => p.id === id));
    const victim = find(m.victim);
    const killer = find(m.killer);
    const a = this.avatars.get(m.victim);
    if (a) {
      this.avatars.delete(m.victim);
      a.die(now);
      this.dying.push(a);
      this.particles.burst(a.pos.clone().setY(a.pos.y + 1), BLOOD, 16, 6);
      sfx.death(this.spatial(a.pos));
    }
    if (m.victim === s.myId) {
      this.deathAt = now;
      this.deathPos.copy(this.pos);
      this.deathYaw = this.yaw;
      this.deathPitch = this.pitch;
      sfx.death();
      this.store.set({ death: { key: ++this.uiKey, killer: killer?.name ?? null, color: killer?.color ?? null, fall: m.reason === "fall", at: now } });
    }
    if (m.killer !== null && m.killer === s.myId) sfx.kill();
    // Infection: a human bitten turns into a zombie.
    if (s.view === "arena" && s.mode === "infection" && victim?.team === 0 && m.reason !== "leave") sfx.infect(a ? this.spatial(a.pos) : undefined);
    if (victim) {
      this.store.set((st) => ({
        feed: [
          ...st.feed.slice(-4),
          {
            key: ++this.feedKey,
            at: now,
            victim: { name: victim.name, color: victim.color },
            killer: killer ? { name: killer.name, color: killer.color } : null,
            reason: m.reason,
          },
        ],
      }));
    }
  }

  private onTick(p: number[]) {
    const s = this.store.get();
    const seen = new Set<number>();
    for (let i = 0; i < p.length; i += 7) {
      const id = p[i];
      if (id === s.myId) continue;
      seen.add(id);
      let a = this.avatars.get(id);
      if (!a) {
        const info = s.players.find((pl) => pl.id === id);
        if (!info) continue;
        a = new Avatar(id, info.name, info.color, { skin: info.skin });
        a.setCrown(info.crown);
        const swungAt = this.recentSwings.get(id);
        if (swungAt !== undefined) a.swing(swungAt);
        this.avatars.set(id, a);
        this.scene.add(a.group);
      }
      a.setTarget(p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5]);
      a.setHp(p[i + 6]);
    }
    for (const id of this.avatars.keys()) if (!seen.has(id)) this.removeAvatar(id);
  }

  /** Hub skeletons: [id, kindIndex, x, y, z, yaw, hp, maxHp, ...]. */
  private syncMobs(rows: number[], now: number) {
    const seen = new Set<number>();
    for (let i = 0; i + 7 < rows.length; i += 8) {
      const id = rows[i];
      const kind = MOB_KINDS[rows[i + 1]] ?? "dummy";
      seen.add(id);
      let a = this.mobs.get(id);
      if (!a) {
        a = new Avatar(id, MOB_LABELS[kind], SKELETON, { mob: kind, labelColor: MOB_LABEL_COLORS[kind] });
        this.mobs.set(id, a);
        this.scene.add(a.group);
        if (kind === "target") this.particles.burst(new THREE.Vector3(rows[i + 2], rows[i + 3] + 1, rows[i + 4]), STARS, 10, 3, 0.1);
      }
      a.setTarget(rows[i + 2], rows[i + 3], rows[i + 4], rows[i + 5], 0);
      a.setHp(rows[i + 6], rows[i + 7]);
    }
    for (const [id, a] of this.mobs) {
      if (seen.has(id)) continue;
      this.mobs.delete(id);
      const at = a.pos.clone().setY(a.pos.y + 1);
      if (a.hp <= 0 && a.mob === "walker") {
        // Beaten: the same topple-and-poof as a player.
        a.die(now);
        this.dying.push(a);
        this.particles.burst(at, BONE_DUST, 16, 5);
        sfx.death(this.spatial(a.pos));
        continue;
      }
      // Range target popped or expired, cliff skeleton fell off: vanish in a puff.
      this.particles.burst(at, a.mob === "target" ? STARS : POOF, a.mob === "target" ? 20 : 14, 4, 0.14);
      this.dropModel(a);
    }
  }

  /** Archer arrows: [id, x, y, z, vx, vy, vz, ...]; between ticks they fly on locally. */
  private syncArrows(rows: number[], now: number) {
    const seen = new Set<number>();
    for (let i = 0; i + 6 < rows.length; i += 7) {
      const id = rows[i];
      seen.add(id);
      let a = this.arrows.get(id);
      if (!a) {
        a = { group: createArrow(), vel: new THREE.Vector3() };
        this.arrows.set(id, a);
        this.scene.add(a.group);
        // The nearest archer just loosed it.
        let archer: Avatar | null = null;
        let best = Infinity;
        for (const m of this.mobs.values()) {
          if (m.mob !== "archer") continue;
          const d = Math.hypot(m.pos.x - rows[i + 1], m.pos.z - rows[i + 3]);
          if (d < best) [archer, best] = [m, d];
        }
        if (archer && best < 4) {
          archer.swing(now);
          sfx.swing(this.spatial(archer.pos));
        }
        const from = new THREE.Vector3(rows[i + 1], rows[i + 2], rows[i + 3]);
        if (this.store.get().view === "arena" && from.distanceTo(this.pos) > 2) sfx.bowShot(this.spatial(from));
      }
      a.group.position.set(rows[i + 1], rows[i + 2], rows[i + 3]);
      a.vel.set(rows[i + 4], rows[i + 5], rows[i + 6]);
      this.aimArrow(a.group, a.vel);
    }
    for (const [id, a] of this.arrows) {
      if (seen.has(id)) continue;
      this.disposeGroup(a.group);
      this.arrows.delete(id);
    }
  }

  private aimArrow(group: THREE.Object3D, vel: THREE.Vector3) {
    if (vel.lengthSq() > 1e-6) group.lookAt(group.position.clone().add(vel));
  }

  private removeAvatar(id: number) {
    const a = this.avatars.get(id);
    if (!a) return;
    this.dropModel(a);
    this.avatars.delete(id);
  }

  private syncBags(list: BagInfo[]) {
    const ids = new Set(list.map((b) => b.id));
    for (const [id, b] of this.bags) {
      if (ids.has(id)) continue;
      this.particles.burst(b.group.position.clone(), ["#facc15", "#a16207"], 10, 4);
      this.disposeGroup(b.group);
      this.bags.delete(id);
    }
    for (const info of list) {
      if (this.bags.has(info.id)) continue;
      const group = new THREE.Group();
      const chest = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.45, 0.4), new THREE.MeshLambertMaterial({ color: "#8b5a2b" }));
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.57, 0.08, 0.42), new THREE.MeshLambertMaterial({ color: "#facc15", emissive: "#5a4500" }));
      band.position.y = 0.06;
      chest.castShadow = true;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(`+${info.dirt} земли`, "#facc15", null) }));
      label.scale.set(1.4, 0.4, 1);
      label.position.y = 0.75;
      group.add(chest, band, label);
      group.position.set(info.x, info.y + 0.4, info.z);
      group.userData.baseY = info.y + 0.4;
      this.scene.add(group);
      this.bags.set(info.id, { info, group });
    }
  }

  private rebuildBlocks() {
    this.blocksDirty = false;
    this.blockMesh.geometry.dispose();
    this.blockMesh.geometry = buildBlockGeometry(this.world);
    const cells = this.floorAoDirty;
    if (cells === "all" || cells.length) applyFloorAo(this.floor, this.world, cells === "all" ? null : cells);
    this.floorAoDirty = [];
  }

  /** Buff looks (fog, lava floor) belong to the arena round only. */
  private refreshVisuals() {
    const s = this.store.get();
    this.applyBuffVisuals(s.view === "arena" && s.phase === "playing" ? s.buffs : []);
  }

  private applyBuffVisuals(buffs: readonly BuffId[]) {
    const mods = buffModifiers(buffs);
    const look = buffs.map((b) => BUFF_LOOKS[b]).find((l) => l !== undefined) ?? null;
    const fog = this.scene.fog as THREE.Fog;
    const horizon = look ? new THREE.Color(look.horizon) : SKY;
    fog.color.copy(horizon);
    [fog.near, fog.far] = look?.fog ?? [70, 190];
    (this.scene.background as THREE.Color).copy(horizon);
    this.scenery.setSkyTint(look ? new THREE.Color(look.top) : null, look ? horizon.clone() : null, look?.sun ? new THREE.Color(look.sun) : null);
    const light = look?.light ?? 1;
    this.hemi.intensity = 1.35 * light;
    this.sun.intensity = 1.9 * light;
    // Clouds ignore lights and fog: dim them with the scene, or they glow at night.
    (this.clouds.material as THREE.MeshBasicMaterial).color.setScalar(Math.max(0.18, light));
    this.floorMat.map = mods.lava ? this.tex.lava : mods.ice ? this.tex.ice : this.tex.grassTop;
    this.floorMat.emissive.set(mods.lava ? "#c2410c" : "#000000");
    this.floorMat.needsUpdate = true;
  }

  // ------------------------------------------------------------------ input

  private get mode(): Mode {
    const s = this.store.get();
    if (s.conn !== "open" || s.myId === null) return "orbit";
    // The hub never stops: walking, training and duels go on through every round phase.
    if (s.view === "hub") return "play";
    if (s.watching) return s.phase === "lobby" ? "orbit" : "spectate";
    if (s.phase === "lobby" || s.phase === "ended") return "orbit";
    if (s.alive) return s.phase === "countdown" ? "frozen" : "play";
    return "spectate";
  }

  /** Physics modifiers for the world we are in: the hub has no buffs and no round mode. */
  private mods() {
    const s = this.store.get();
    return s.view === "arena" ? buffModifiers(s.buffs, s.mode, this.mySize()) : buffModifiers(null);
  }

  /** Our size (giants buff): eyes, hit box and speed follow it. */
  private mySize() {
    const s = this.store.get();
    return s.view === "arena" ? (s.players.find((p) => p.id === s.myId)?.size ?? 1) : 1;
  }

  private spatialOf(id: number) {
    const a = this.avatars.get(id);
    return a ? this.spatial(a.pos) : undefined;
  }

  /** Bows buff: Q looses an arrow along the view. */
  private shoot() {
    const now = performance.now();
    if (this.store.get().arrows <= 0 || now - this.lastShotAt < 650) return;
    this.lastShotAt = now;
    this.flushMove();
    this.send({ t: "shoot", yaw: this.yaw, pitch: this.pitch, tk: this.lastTick });
    this.swingArm(now);
    sfx.bowShot();
  }

  /** An eliminated player's vote for the next buff. */
  vote(i: number) {
    const v = this.store.get().vote;
    if (!v || i < 0 || i >= v.options.length) return;
    this.send({ t: "buffVote", i });
    this.store.set({ vote: { ...v, mine: i } });
    sfx.vote();
  }

  private preventDefault = (e: Event) => e.preventDefault();

  private onResize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = this.handCamera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.handCamera.updateProjectionMatrix();
  }

  private isTyping(e: Event) {
    const t = e.target as HTMLElement | null;
    // A focused slider (sensitivity) is not typing: Esc and H still close the overlay.
    const text = t?.tagName === "INPUT" && (t as HTMLInputElement).type !== "range";
    return !!t && (text || t.tagName === "TEXTAREA" || t.isContentEditable);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.isTyping(e)) return;
    if (e.code === "KeyM" && !e.repeat) this.toggleMute();
    const s = this.store.get();
    if (s.conn !== "open") return;
    const inHub = s.view === "hub" && !s.watching;
    const overlay = s.wardrobe || s.help;
    if (!e.repeat) {
      if (overlay && (e.code === "Escape" || (e.code === "KeyE" && s.wardrobe) || (e.code === "KeyH" && s.help))) {
        this.setOverlay({ wardrobe: false, help: false });
        return;
      }
      if (e.code === "KeyH" && inHub) return this.setHelp(true);
      if ((e.code === "KeyY" || e.code === "KeyN") && s.invite && performance.now() - s.invite.at < INVITE_MS) {
        return this.answerDuel(e.code === "KeyY");
      }
      if (e.code === "KeyT" && !overlay) return this.toggleWatch();
    }
    if (overlay) return;
    const mode = this.mode;
    if (mode === "orbit") return;
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code)) e.preventDefault();
    const forwardHeld = this.keys.has("KeyW") || this.keys.has("ArrowUp");
    this.keys.add(e.code);
    if (e.repeat) return;
    // The key's own time, not when a busy frame got round to it: on a slow PC two quick taps
    // may be handled far apart.
    if ((e.code === "KeyW" || e.code === "ArrowUp") && !forwardHeld && mode === "play") this.forwardTap(e.timeStamp || performance.now());
    if (e.code === "KeyV" && (mode === "play" || mode === "frozen")) this.thirdPerson = !this.thirdPerson;
    if (e.code === "KeyQ" && mode === "play" && s.view === "arena") this.shoot();
    if (/^Digit[123]$/.test(e.code) && s.vote && !s.alive) this.vote(Number(e.code.slice(5)) - 1);
    if (inHub) {
      if (e.code === "KeyE" && s.nearWardrobe && !this.inDuel()) this.setWardrobe(true);
      if (e.code === "KeyF" && s.duelTarget && !this.inDuel()) this.send({ t: "duel", id: s.duelTarget.id });
    }
    if (mode === "spectate") {
      if (e.code === "KeyV") {
        const order: SpecMode[] = ["third", "first", "free"];
        this.specMode = order[(order.indexOf(this.specMode) + 1) % order.length];
        if (this.specMode === "free") this.specPos.copy(this.camera.position);
      }
      if (e.code === "KeyE" || e.code === "ArrowRight") this.cycleTarget(1);
      if (e.code === "KeyQ" || e.code === "ArrowLeft") this.cycleTarget(-1);
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onBlur = () => {
    this.keys.clear();
    this.mouse.left = this.mouse.right = false;
  };

  private onMouseDown = (e: MouseEvent) => {
    sfx.unlock();
    const mode = this.mode;
    const s = this.store.get();
    if (mode === "orbit" || s.wardrobe || s.help) return;
    const el = this.renderer.domElement;
    if (document.pointerLockElement !== el) {
      this.lockPointer();
      return;
    }
    if (mode === "spectate") {
      if (e.button === 0) this.cycleTarget(1);
      if (e.button === 2) this.cycleTarget(-1);
      return;
    }
    if (e.button === 0) {
      this.mouse.left = true;
      this.primaryAction(true);
    }
    if (e.button === 2) {
      this.mouse.right = true;
      this.secondaryAction(true);
    }
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouse.left = false;
    if (e.button === 2) this.mouse.right = false;
  };

  private onWheel = (e: WheelEvent) => {
    if (this.mode === "spectate") this.cycleTarget(e.deltaY > 0 ? 1 : -1);
  };

  /** Raw mouse input (Chromium): no OS acceleration, so the same hand movement always turns the
   *  same amount, and none of the wild deltas Windows' cursor warping causes with high polling rate
   *  mice. Falls back to a plain lock where raw input isn't supported. */
  private lockPointer() {
    const el = this.renderer.domElement;
    const plain = () => {
      Promise.resolve(el.requestPointerLock()).catch(() => {});
    };
    let req: Promise<void> | undefined;
    try {
      req = el.requestPointerLock({ unadjustedMovement: true });
    } catch {
      return plain();
    }
    // Browsers without the promise API ignore the option and lock anyway.
    if (!req) return;
    req.catch((err: unknown) => {
      if ((err as { name?: string } | null)?.name === "NotSupportedError") plain();
    });
  }

  /** The mouse delta to use, or null for an outlier. Without raw input, Chromium on Windows and
   *  Firefox sometimes report a single delta about half the window across (the cursor being warped
   *  back to the centre). A real flick builds up over several events, so a sudden jump that big is
   *  dropped, unless the next one continues in the same direction. */
  private readMouse(e: MouseEvent): [number, number] | null {
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    const mag = Math.max(Math.abs(dx), Math.abs(dy));
    const last = this.mouseLast;
    const recent = e.timeStamp - last.at < 100;
    const huge = Math.abs(dx) > window.innerWidth / 3 || Math.abs(dy) > window.innerHeight / 3;
    if (huge && mag > (recent ? last.mag : 0) * 3 + 40) {
      const dir = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 2 * Math.sign(dy);
      if (!recent || last.dropped !== dir) {
        this.mouseLast = { at: e.timeStamp, mag: last.mag, dropped: dir };
        return null;
      }
    }
    this.mouseLast = { at: e.timeStamp, mag, dropped: 0 };
    return [dx, dy];
  }

  private onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== this.renderer.domElement) return;
    const d = this.readMouse(e);
    if (!d) return;
    const k = MOUSE_SENS * this.sens;
    const lim = Math.PI / 2 - 0.01;
    if (this.mode === "spectate") {
      this.specYaw -= d[0] * k;
      this.specPitch = Math.max(-lim, Math.min(lim, this.specPitch - d[1] * k));
    } else {
      this.yaw -= d[0] * k;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch - d[1] * k));
    }
  };

  private onLockChange = () => {
    const locked = document.pointerLockElement === this.renderer.domElement;
    this.store.set({ locked });
    // The first delta after locking may carry the cursor's jump to the centre: judge it on its own.
    this.mouseLast = { at: -1e9, mag: 0, dropped: 0 };
    if (!locked) this.mouse.left = this.mouse.right = false;
  };

  private cycleTarget(dir: number) {
    const ids = [...this.avatars.keys()].sort((a, b) => a - b);
    if (!ids.length) return;
    if (this.specMode === "free") this.specMode = "third";
    const i = this.specTarget === null ? -1 : ids.indexOf(this.specTarget);
    this.specTarget = ids[(i + dir + ids.length) % ids.length];
  }

  // ------------------------------------------------------------------ actions

  private eyeRay() {
    const origin = new THREE.Vector3(this.pos.x, this.pos.y + EYE_HEIGHT * this.mySize(), this.pos.z);
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
    return { origin, dir };
  }

  private primaryAction(fresh: boolean) {
    if (this.mode !== "play") return;
    const now = performance.now();
    const { origin, dir } = this.eyeRay();
    const target = this.pickTarget(origin, dir, HIT_REACH);
    const block = this.raycast(origin, dir, BUILD_REACH);
    if (target && (!block || target.t < block.t)) {
      if (now - this.lastHitAt < HIT_COOLDOWN_MS || this.simTime - this.actionSim.hit < HIT_COOLDOWN_MS) return;
      this.lastHitAt = now;
      this.actionSim.hit = this.simTime;
      this.swingArm(now);
      sfx.swing();
      this.flushMove();
      this.send({ t: "hit", id: target.id, yaw: this.yaw, pitch: this.pitch, tk: this.lastTick });
      if (this.sprinting) {
        // Minecraft: the hit takes the run out of you; sprint again with a fresh double-tap.
        this.sprinting = false;
        this.vel.x *= SPRINT_HIT_SLOW;
        this.vel.z *= SPRINT_HIT_SLOW;
      }
      return;
    }
    if (block && !block.floor && this.canBreak(block)) {
      const wait = fresh ? 120 : BREAK_REPEAT_MS;
      if (now - this.lastBreakAt < wait || this.simTime - this.actionSim.break < wait) return;
      this.lastBreakAt = now;
      this.actionSim.break = this.simTime;
      this.swingArm(now);
      this.flushMove();
      this.send({ t: "break", x: block.x, y: block.y, z: block.z });
      return;
    }
    if (fresh && now - this.swingAt > 250) {
      this.swingArm(now);
      sfx.swing();
    }
  }

  private swingArm(now: number) {
    this.swingAt = now;
    this.selfAvatar?.swing(now);
  }

  private buildHandSword() {
    const { group } = createSwordModel();
    group.matrixAutoUpdate = false;
    this.handScene.add(group);
    return group;
  }

  /** Changes the sword's look for everyone drawn on this screen and how the hand animates. */
  setSword(style: Partial<SwordStyle>) {
    setSwordStyle(style);
    this.handScene.remove(this.handSword);
    this.disposeGroup(this.handSword);
    this.handSword = this.buildHandSword();
    // Models are rebuilt with the new sword on the next tick.
    for (const id of [...this.avatars.keys()]) this.removeAvatar(id);
    this.dropSelfAvatar();
  }

  /** The sword in first person, posed like Minecraft's: lags behind turns, bobs with steps, swings
   *  over 6 ticks and, in the 1.9+ style, dips after a hit until the cooldown is over. */
  private updateHand(dt: number, t: number) {
    const h = this.hand;
    const k = 1 - Math.exp(-dt * SWAY_RATE);
    h.pitch += (this.pitch - h.pitch) * k;
    h.yaw += Math.atan2(Math.sin(this.yaw - h.yaw), Math.cos(this.yaw - h.yaw)) * k;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    h.walk += hs * dt * 0.6;
    const bobTo = this.body.onGround ? Math.min(0.1, hs * 0.05) : 0;
    h.bob += (bobTo - h.bob) * (1 - Math.exp(-dt * BOB_RATE));
    const strength = Math.min(1, Math.max(0, (t - this.lastHitAt) / HIT_COOLDOWN_MS));
    const height = swordStyle.swing === "modern" ? strength * strength * strength : 1;
    h.height += Math.max(-HAND_HEIGHT_RATE * dt, Math.min(HAND_HEIGHT_RATE * dt, height - h.height));
    const p = (t - this.swingAt) / SWING_MS;
    firstPersonMatrix(h.matrix, {
      swing: p >= 0 && p < 1 ? p : 0,
      equip: 1 - h.height,
      // Minecraft's signs: pitch down and yaw right positive.
      swayPitch: -(this.pitch - h.pitch),
      swayYaw: -Math.atan2(Math.sin(this.yaw - h.yaw), Math.cos(this.yaw - h.yaw)),
      walk: h.walk,
      bob: h.bob,
    });
    this.handSword.matrix.copy(h.matrix);
    this.handSword.matrixWorldNeedsUpdate = true;
    this.handCamera.rotation.z = this.shakeRoll;
  }

  private secondaryAction(fresh: boolean) {
    if (this.mode !== "play") return;
    const now = performance.now();
    const wait = fresh ? 80 : PLACE_REPEAT_MS;
    if (now - this.lastPlaceAt < wait || this.simTime - this.actionSim.place < wait) return;
    const s = this.store.get();
    const inHub = s.view === "hub";
    // Hub building is free (the blocks vanish on their own), arena building spends dirt.
    if (inHub ? this.inDuel() : s.dirt <= 0) return;
    const { origin, dir } = this.eyeRay();
    const hit = this.raycast(origin, dir, BUILD_REACH);
    if (!hit) return;
    const x = hit.x + hit.nx;
    const y = hit.y + hit.ny;
    const z = hit.z + hit.nz;
    if (!Voxels.inBounds(x, y, z) || this.world.get(x, y, z)) return;
    if (inHub ? !inCellBox(x, z, HUB.build) || y >= HUB.buildMaxY : !cellInRing(x, z, this.store.get().floor)) return;
    const p = this.pos;
    if (p.x + HW > x && p.x - HW < x + 1 && p.z + HW > z && p.z - HW < z + 1 && p.y + PH > y && p.y < y + 1) return;
    this.lastPlaceAt = now;
    this.actionSim.place = this.simTime;
    this.flushMove();
    this.send({ t: "place", x, y, z });
  }

  /** In the hub only blocks players placed in the build area can go (they are all dirt). */
  private canBreak(b: VoxelHit) {
    if (this.store.get().view === "arena") return true;
    return this.world.get(b.x, b.y, b.z) === BLOCK.dirt && inCellBox(b.x, b.z, HUB.build);
  }

  /** What a swing would hit: arena players, or in the hub the skeletons and the duel opponent. */
  private pickTarget(origin: THREE.Vector3, dir: THREE.Vector3, reach: number): Target | null {
    const s = this.store.get();
    if (s.view === "arena") return this.pickAmong(this.avatars.values(), origin, dir, reach, false);
    const mob = this.pickAmong(this.mobs.values(), origin, dir, reach, true);
    const d = s.duel;
    const opp = d?.state === "fight" ? this.avatars.get(d.opponent) : undefined;
    const player = opp ? this.pickAmong([opp], origin, dir, reach, false) : null;
    return player && (!mob || player.t < mob.t) ? player : mob;
  }

  private pickAmong(list: Iterable<Avatar>, origin: THREE.Vector3, dir: THREE.Vector3, reach: number, mob: boolean): Target | null {
    let best: Target | null = null;
    const pad = 0.1;
    for (const a of list) {
      const k = mob ? 1 : a.scale;
      const min = [a.pos.x - HW * k - pad, a.pos.y - pad, a.pos.z - HW * k - pad];
      const max = [a.pos.x + HW * k + pad, a.pos.y + PH * k + pad, a.pos.z + HW * k + pad];
      const o = [origin.x, origin.y, origin.z];
      const d = [dir.x, dir.y, dir.z];
      let t0 = 0;
      let t1 = reach;
      let ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        if (Math.abs(d[k]) < 1e-9) {
          if (o[k] < min[k] || o[k] > max[k]) ok = false;
          continue;
        }
        let ta = (min[k] - o[k]) / d[k];
        let tb = (max[k] - o[k]) / d[k];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) ok = false;
      }
      if (ok && (!best || t0 < best.t)) best = { id: a.id, t: t0, mob };
    }
    return best;
  }

  private raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): VoxelHit | null {
    return raycastVoxels(this.world, origin, dir, maxDist);
  }

  // ------------------------------------------------------------------ simulation

  /** The hub's wall; the arena has none: past the island's edge you fall. */
  private ringRadius() {
    return this.store.get().view === "arena" ? Infinity : ARENA_RADIUS;
  }

  private updatePlay(dt: number, now: number) {
    const mods = this.mods();
    const k = this.keys;
    const forward = this.forwardInput();
    const strafe = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    // The sprint ends once forward is let go (or S is held too), and after a head-on wall hit.
    const wasSprinting = this.sprinting;
    if (forward <= 0) this.sprinting = false;
    const wasOnGround = this.body.onGround;
    const vyBefore = Math.max(-MAX_FALL_SPEED, this.vel.y - GRAVITY * mods.gravity * dt);
    if (this.sprinting) this.sprintedSinceSend = true;
    stepBody(this.world, this.body, { forward, strafe, jump: k.has("Space"), yaw: this.yaw, sprint: this.sprinting }, dt, mods, this.ringRadius());
    if (this.body.bumped) this.sprinting = false;
    this.simTime += dt * 1000;
    if (this.body.onGround && !wasOnGround && vyBefore < -8) sfx.land(-vyBefore);
    if (this.sprinting && this.body.onGround && now - this.dustAt >= 50) {
      this.dustAt = now;
      this.sprintDust(this.pos);
    }

    if (this.mouse.left) this.primaryAction(false);
    if (this.mouse.right) this.secondaryAction(false);

    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.body.onGround && hs > 0.8) {
      const before = Math.floor(this.walkPhase / Math.PI);
      this.walkPhase += hs * dt * 1.6;
      if (Math.floor(this.walkPhase / Math.PI) !== before) sfx.step();
    }
    // Like Minecraft's sprint packet: the server hears right away that the sprint is over.
    if (now - this.lastSend >= SEND_INTERVAL || (wasSprinting && !this.sprinting)) this.sendMove(now);
  }

  /** Minecraft's double-tap: a fresh forward press on the ground arms a 7-tick window, a second
   *  press within it (also on the ground) starts the sprint. */
  private forwardTap(now: number) {
    if (!this.body.onGround || this.sprinting || this.forwardInput() <= 0) return;
    if (now - this.sprintTapAt <= SPRINT_TAP_MS) this.sprinting = true;
    else this.sprintTapAt = now;
  }

  private forwardInput() {
    const k = this.keys;
    return (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
  }

  /** Feet kick up bits of whatever they run on. */
  private sprintDust(at: THREE.Vector3) {
    const below = this.world.get(Math.floor(at.x), Math.floor(at.y - 0.05), Math.floor(at.z));
    const s = this.store.get();
    const lava = s.view === "arena" && s.phase === "playing" && s.buffs.includes("lava");
    const colors = below ? (DUST[below] ?? DUST[1]) : lava ? LAVA_DUST : DUST[0];
    this.particles.burst(at.clone().setY(at.y + 0.1), colors, 1, 1.6, 0.07);
  }

  private dropSelfAvatar() {
    if (!this.selfAvatar) return;
    this.dropModel(this.selfAvatar);
    this.selfAvatar = null;
  }

  /** Our own model for third person: built on demand from the roster, follows the body exactly. */
  private updateSelfAvatar(dt: number, t: number, show: boolean, drop: number, invisible: boolean) {
    if (!show) {
      if (this.selfAvatar) this.selfAvatar.group.visible = false;
      return;
    }
    const s = this.store.get();
    let a = this.selfAvatar;
    if (!a) {
      const me: PlayerInfo | undefined = s.players.find((p) => p.id === s.myId);
      if (!me) return;
      a = new Avatar(me.id, me.name, me.color, { skin: me.skin, noLabel: true });
      a.setCrown(me.crown);
      a.followRate = Infinity;
      this.selfAvatar = a;
      this.scene.add(a.group);
    }
    a.group.visible = true;
    a.setTarget(this.pos.x, this.pos.y + drop, this.pos.z, this.yaw, this.pitch);
    a.update(dt, t, invisible);
  }

  /** Behind the eyes along the view, like Minecraft's F5, pulled in front of anything in the way. */
  private placeThirdPersonCamera(eye: THREE.Vector3) {
    const back = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
    const hit = raycastVoxels(this.world, eye, back, THIRD_PERSON_DIST);
    let dist = hit ? Math.max(0.2, hit.t - 0.2) : THIRD_PERSON_DIST;
    // Past the island's rim there's no floor to stop the ray: keep the camera above ground level.
    if (back.y < -1e-3) dist = Math.min(dist, Math.max(0.2, (eye.y - 0.2) / -back.y));
    this.camera.position.copy(eye).addScaledVector(back, dist);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  /** Hub prompts: the wardrobe next to us (E) and the player in the crosshair (F, duel). */
  private updateHubFocus() {
    const s = this.store.get();
    const inHub = s.conn === "open" && s.view === "hub" && !s.watching;
    const w = HUB.wardrobe;
    const near = inHub && this.pos.y < 2 && inCircle(this.pos.x, this.pos.z, { x: w.x, z: w.z, r: w.r + 0.5 });
    let target: UiState["duelTarget"] = null;
    if (inHub && !this.inDuel()) {
      const { origin, dir } = this.eyeRay();
      const hit = this.pickAmong(this.avatars.values(), origin, dir, DUEL_RANGE + 1, false);
      const wall = hit && this.raycast(origin, dir, hit.t);
      const a = hit && !wall ? this.avatars.get(hit.id) : undefined;
      if (a && Math.hypot(a.pos.x - this.pos.x, a.pos.z - this.pos.z) <= DUEL_RANGE) {
        target = { id: a.id, name: s.players.find((p) => p.id === a.id)?.name ?? a.name };
      }
    }
    if (near !== s.nearWardrobe || target?.id !== s.duelTarget?.id) this.store.set({ nearWardrobe: near, duelTarget: target });
  }

  /** Fireworks for the round winner (over the pedestal in the hub, around them on the arena's end
   *  screen) and a glitter of sparks around every crown. */
  private updateCelebration(t: number, invisible: boolean) {
    const s = this.store.get();
    if (t >= this.nextSparkle) {
      this.nextSparkle = t + 120;
      // Players on a kill streak burn.
      const hot = new Set(s.view === "arena" ? s.players.filter((p) => p.alive && p.kills >= HOT_STREAK).map((p) => p.id) : []);
      for (const a of this.avatars.values()) {
        if (!a.group.visible || invisible) continue;
        if (a.crowned) {
          const at = new THREE.Vector3(a.pos.x + (Math.random() - 0.5) * 0.7, a.pos.y + 2 + Math.random() * 0.3, a.pos.z + (Math.random() - 0.5) * 0.7);
          this.fireworks.sparkle(at, Math.random() < 0.5 ? "#ffde59" : "#fff7ae");
        }
        if (!hot.has(a.id)) continue;
        for (const color of EMBERS) {
          const at = new THREE.Vector3(a.pos.x + (Math.random() - 0.5) * 0.8, a.pos.y + 0.2 + Math.random() * 1.7, a.pos.z + (Math.random() - 0.5) * 0.8);
          this.fireworks.sparkle(at, color);
        }
      }
    }
    if (s.conn !== "open" || s.winnerId === null || t < this.nextFirework) return;
    let at: THREE.Vector3 | null = null;
    if (s.view === "hub" && s.phase === "lobby" && t - s.phaseStartedAt < CELEBRATE_MS) {
      at = new THREE.Vector3(HUB.pedestal.x, 0, HUB.pedestal.z);
    } else if (s.view === "arena" && s.phase === "ended") {
      const w = s.winnerId === s.myId ? this.pos : this.avatars.get(s.winnerId)?.pos;
      if (w) at = new THREE.Vector3(w.x, w.y, w.z);
    }
    if (!at) return;
    this.nextFirework = t + 380 + Math.random() * 420;
    const a = Math.random() * Math.PI * 2;
    const r = 3 + Math.random() * 4;
    const from = at.add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    const winner = s.players.find((p) => p.id === s.winnerId)?.color ?? "#ffde59";
    const extra = FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)];
    this.fireworks.launch(from, [winner, extra, "#ffde59", "#ffffff"]);
    sfx.fireworkLaunch(this.spatial(from));
  }

  /** Round start: height above the spawn while everyone drops in during the countdown. */
  private dropHeight(t: number) {
    const s = this.store.get();
    if (s.view !== "arena" || s.phase !== "countdown") return 0;
    const k = Math.min(1, Math.max(0, (t - s.phaseStartedAt) / (s.timings.countdownMs * DROP_SHARE)));
    return DROP_HEIGHT * (1 - k * k);
  }

  private updateSpectate(dt: number) {
    // Stay on a spectated player while their death animation plays, then move on.
    const dyingTarget = this.dying.find((a) => a.id === this.specTarget);
    const targets = [...this.avatars.keys()];
    if (this.specMode !== "free" && !dyingTarget && (this.specTarget === null || !this.avatars.has(this.specTarget))) {
      this.specTarget = targets.sort((a, b) => a - b)[0] ?? null;
    }
    const target = dyingTarget ?? (this.specTarget !== null ? this.avatars.get(this.specTarget) : undefined);
    const mode: SpecMode = !target ? "free" : dyingTarget && this.specMode === "first" ? "third" : this.specMode;
    for (const a of this.avatars.values()) a.group.visible = !(mode === "first" && a === target);

    if (mode === "free" || !target) {
      const k = this.keys;
      const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this.specPitch, this.specYaw, 0, "YXZ"));
      const right = new THREE.Vector3(Math.cos(this.specYaw), 0, -Math.sin(this.specYaw));
      const move = new THREE.Vector3();
      if (k.has("KeyW") || k.has("ArrowUp")) move.add(dir);
      if (k.has("KeyS") || k.has("ArrowDown")) move.sub(dir);
      if (k.has("KeyD")) move.add(right);
      if (k.has("KeyA")) move.sub(right);
      if (k.has("Space")) move.y += 1;
      if (k.has("ShiftLeft") || k.has("ShiftRight")) move.y -= 1;
      if (move.lengthSq()) this.specPos.addScaledVector(move.normalize(), 14 * dt);
      const r = Math.hypot(this.specPos.x, this.specPos.z);
      if (r > 80) this.specPos.multiplyScalar(80 / r);
      this.specPos.y = Math.max(-6, Math.min(45, this.specPos.y));
      this.camera.position.copy(this.specPos);
      this.camera.rotation.set(this.specPitch, this.specYaw, 0);
    } else if (mode === "first") {
      this.camera.position.copy(target.eye);
      this.camera.rotation.set(target.pitch, target.yaw, 0);
    } else {
      const eye = target.eye;
      const back = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this.specPitch, this.specYaw, 0, "YXZ"));
      this.camera.position.copy(eye).addScaledVector(back, -4.5);
      this.camera.lookAt(eye);
    }

    const prev = this.store.get().spectate;
    const name = target ? (this.store.get().players.find((p) => p.id === target.id)?.name ?? null) : null;
    if (!prev || prev.mode !== mode || prev.target !== name) this.store.set({ spectate: { mode, target: name } });
  }

  /** Own death: the camera drops to the floor and tips over before spectating starts. */
  private updateDeathCam(t: number) {
    const k = Math.min(1, (t - this.deathAt) / 700);
    const e = 1 - (1 - k) * (1 - k);
    this.camera.position.set(this.deathPos.x, this.deathPos.y + EYE_HEIGHT + (0.25 - EYE_HEIGHT) * e, this.deathPos.z);
    this.camera.rotation.set(this.deathPitch * (1 - e) - 0.25 * e, this.deathYaw, 1.25 * e);
  }

  private applyShake(dt: number, t: number, active: boolean) {
    this.trauma = Math.max(0, this.trauma - dt * 1.8);
    this.fovKick *= Math.exp(-dt * 7);
    const sprintFov = this.sprinting && this.mode === "play" ? SPRINT_FOV : 1;
    this.fovMod += (sprintFov - this.fovMod) * (1 - Math.exp(-dt * FOV_EASE));
    const fov = BASE_FOV * this.fovMod + (active ? this.fovKick : 0);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    if (!active || this.trauma <= 0) return;
    // Roll only: it keeps the screen centre where the player aims, so the crosshair never drifts
    // off what a swing would actually hit.
    const k = this.trauma * this.trauma;
    this.shakeRoll = Math.sin((t / 1000) * 55.7 + 2.1) * 0.075 * k;
    this.camera.rotation.z += this.shakeRoll;
  }

  private updateDying(t: number) {
    this.dying = this.dying.filter((a) => {
      if (a.updateDying(t)) return true;
      const at = a.pos.clone().setY(a.pos.y + 0.4);
      this.particles.burst(at, a.palette, 36, 6, 0.17);
      this.particles.burst(at, POOF, 14, 3, 0.22);
      this.scene.remove(a.group);
      a.dispose();
      return false;
    });
  }

  /** Countdown beeps, the "go" signal and ticking over the last 10 seconds; in the hub the range and
   *  duel countdowns and the last seconds before the round starts. */
  private updateCues(t: number) {
    const s = this.store.get();
    const elapsed = t - s.phaseStartedAt;
    const arena = s.view === "arena";
    let cue = "";
    if (s.conn === "open" && arena && s.phase === "countdown") {
      cue = `c${Math.max(1, Math.ceil((s.timings.countdownMs - elapsed) / 1000))}`;
    } else if (s.conn === "open" && arena && s.phase === "playing") {
      const clock = roundClock(elapsed, s.timings);
      const left = Math.ceil(clock.left / 1000);
      if (elapsed < 800) cue = "go";
      else if (left > 0 && left <= 10) cue = `${clock.overtime ? "o" : "t"}${left}`;
    } else if (s.conn === "open" && !arena) {
      const until = s.range?.state === "countdown" ? s.range.endsAt : s.duel?.state === "countdown" ? s.duel.endsAt : null;
      const start = s.phase === "lobby" ? (s.hub?.startAt ?? null) : null;
      if (until !== null && until > t) cue = `c${Math.ceil((until - t) / 1000)}`;
      else if (start !== null && start - t > 0 && start - t <= 5000) cue = `l${Math.ceil((start - t) / 1000)}`;
    }
    if (cue === this.lastCue) return;
    this.lastCue = cue;
    if (cue === "go") sfx.beep(true);
    else if (cue.startsWith("c")) sfx.beep(false);
    else if (cue.startsWith("t") || cue.startsWith("o") || cue.startsWith("l")) sfx.tick(Number(cue.slice(1)) <= 3);
  }

  private frame = (t: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    const mode = this.mode;
    const s = this.store.get();
    const arena = s.view === "arena";
    const invisible = arena && s.phase === "playing" && s.buffs.includes("invisible");

    if (mode !== this.prevMode) {
      if (mode === "spectate") {
        this.specMode = "third";
        this.specTarget = null;
      }
      if (mode !== "spectate") {
        for (const a of this.avatars.values()) a.group.visible = true;
        if (s.spectate) this.store.set({ spectate: null });
      }
      this.keys.clear();
      if (mode !== "play") this.sprinting = false;
      this.prevMode = mode;
    }
    this.syncIsland(t);
    this.syncRoundFx(t);
    this.updateCues(t);
    this.updateBombTick(t);

    const stopped = t < this.hitStopUntil;
    if (stopped) this.swingAt += dt * 1000;

    if (mode === "play") this.updatePlay(dt, t);
    this.updateHubFocus();
    const deathCam = mode === "spectate" && t - this.deathAt < DEATH_CAM_MS;
    const drop = this.dropHeight(t);
    const third = this.thirdPerson && (mode === "play" || mode === "frozen");
    if (third) {
      this.placeThirdPersonCamera(new THREE.Vector3(this.pos.x, this.pos.y + EYE_HEIGHT * this.mySize() + drop, this.pos.z));
    } else if (mode === "play" || mode === "frozen") {
      this.camera.position.set(this.pos.x, this.pos.y + EYE_HEIGHT * this.mySize() + drop, this.pos.z);
      this.camera.rotation.set(this.pitch - Math.min(0.6, drop * 0.02), this.yaw, 0);
    }
    if (mode === "play" || mode === "frozen") {
      if (mode === "frozen" && drop === 0 && !this.landed) {
        this.landed = true;
        sfx.land(18);
        this.trauma = Math.min(1, this.trauma + 0.35);
        this.particles.burst(this.pos.clone().setY(this.pos.y + 0.1), DIRT_BITS, 18, 4);
      }
    } else if (deathCam) {
      this.updateDeathCam(t);
    } else if (mode === "spectate") {
      this.updateSpectate(dt);
    } else {
      this.orbitAngle += dt * 0.06;
      this.camera.position.set(Math.cos(this.orbitAngle) * 64, 24, Math.sin(this.orbitAngle) * 64);
      this.camera.lookAt(0, 2, 0);
    }
    this.applyShake(dt, t, mode === "play" || mode === "frozen" || deathCam);

    if (!stopped) {
      for (const a of this.avatars.values()) a.update(dt, t, invisible);
      for (const a of this.mobs.values()) a.update(dt, t, false);
    }
    // Not frozen by hit-stop: the camera keeps following the body, and so must our own model.
    this.updateSelfAvatar(dt, t, third, drop, invisible);
    if (!stopped && !invisible && t - this.othersDustAt >= 50) {
      this.othersDustAt = t;
      // Other players sprinting: faster than anyone can walk right now.
      const walk = WALK_SPEED * this.mods().speed;
      for (const a of this.avatars.values()) {
        if (!a.group.visible || a.moveSpeed < walk * 1.15) continue;
        const onGround = this.world.solid(Math.floor(a.pos.x), Math.floor(a.pos.y - 0.05), Math.floor(a.pos.z));
        if (onGround && Math.abs(a.pos.y - Math.round(a.pos.y)) < 0.05) this.sprintDust(a.pos);
      }
    }
    if (invisible && !stopped) this.trackFootprints(t);
    // Everyone else drops in from the sky together with us.
    if (drop > 0) for (const a of this.avatars.values()) a.group.position.y += drop;
    for (const a of this.arrows.values()) {
      a.group.position.addScaledVector(a.vel, dt);
      a.vel.y -= ARROW_GRAVITY * dt;
      this.aimArrow(a.group, a.vel);
    }
    this.updateDying(t);
    for (const { group } of this.bags.values()) {
      group.rotation.y += dt * 1.5;
      group.position.y = group.userData.baseY + Math.sin(t / 300) * 0.08;
    }
    this.particles.update(stopped ? 0 : dt);
    this.updateCelebration(t, invisible);
    this.fireworks.update(stopped ? 0 : dt);
    this.numbers.update(t);
    this.hubScene.group.visible = !arena;
    if (!arena) this.hubScene.update(s, t, this.camera.position);

    const showHand = (mode === "play" || mode === "frozen") && !third;
    glintTime.value = t / 1000;
    if (showHand) this.updateHand(dt, t);

    // Block highlight; in the hub only where building is allowed.
    this.highlight.visible = false;
    if (mode === "play") {
      const { origin, dir } = this.eyeRay();
      const hit = this.raycast(origin, dir, BUILD_REACH);
      const target = this.pickTarget(origin, dir, HIT_REACH);
      const editable = hit && (arena || inCellBox(hit.x, hit.z, HUB.build) || inCellBox(hit.x + hit.nx, hit.z + hit.nz, HUB.build));
      if (hit && editable && (!target || hit.t < target.t)) {
        this.highlight.visible = true;
        this.highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      }
    }

    // The hub keeps a faint border wall and no ceiling grid; the arena's edge is a drop.
    this.ring.visible = !arena;
    this.ring.scale.set(ARENA_RADIUS, 1, ARENA_RADIUS);
    this.ringMat.opacity = 0.3;
    // Hidden while dropping in from above it.
    this.ceiling.visible = arena && drop === 0;
    this.ceilingMat.opacity = Math.max(0, Math.min(0.35, (this.camera.position.y - 9) / 20));
    this.clouds.position.x = ((t / 1000) * 0.8) % 60;
    this.scenery.update(t, this.camera.position);

    if (this.blocksDirty) this.rebuildBlocks();
    this.renderer.render(this.scene, this.camera);
    if (showHand) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.handScene, this.handCamera);
      this.renderer.autoClear = true;
    }
  };
}
