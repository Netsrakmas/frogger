/**
 * CROAK - feel constants. PROMPT.md section 5.
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH FOR EVERY GAMEPLAY TUNABLE.
 * No gameplay number may be inlined anywhere else in the codebase.
 * Frames are at 60 fps. World units: the frog is ~1u tall.
 */

/** Simulation runs at a fixed 60 Hz. */
export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;
/** Accumulator clamp - never step more than this many times in one frame. */
export const MAX_STEPS_PER_FRAME = 5;

/** Frames -> seconds. Gameplay code should express durations in frames. */
export const f = (frames: number): number => frames / TICK_HZ;

// ---------------------------------------------------------------- movement
export const MOVE_SPEED = 5.0; // u/s
export const ACCEL_TIME = f(4); // s to reach full speed
export const DECEL_TIME = f(3); // s to full stop
/** Frog turns to face movement direction at this rate. */
export const TURN_RATE = 14.0; // rad/s

// -------------------------------------------------------------------- roll
export const ROLL_DURATION = f(26);
/**
 * i-frames cover the first 14 of the roll's 26 frames - "invulnerable for the
 * first half". The window is half-open [START, END) and opens on the commit
 * frame itself, following the Souls rule that i-frames begin on frame 1 of the
 * animation: the frame you spend deciding to dodge must already be covered, or
 * the dust cloud lies about when you were safe.
 */
export const ROLL_IFRAME_START = f(0);
export const ROLL_IFRAME_END = f(14);
export const ROLL_DISTANCE = 3.0; // u
/** Fraction of the stamina bar one roll costs. */
export const ROLL_STAMINA = 0.27;
/** Roll speed curve: fast out, settle. Sampled over normalised roll time. */
export const ROLL_SPEED_CURVE = (t: number): number => 1 - Math.pow(t, 2.2);

// ----------------------------------------------------------------- stamina
export const STAMINA_MAX = 1.0;
/** Bar refills over this many seconds once regen starts. */
export const STAMINA_REGEN_RATE = 0.55; // per second
export const STAMINA_REGEN_DELAY = 0.8; // s after any spend
export const STAMINA_REGEN_DELAY_EMPTY = 1.5; // s after hitting zero
/** Tunic's forgiveness-with-a-cost: rolling at zero stamina still works. */
export const ZERO_STAMINA_DMG_MULT = 1.5;

// ------------------------------------------------------------------- input
export const INPUT_BUFFER = f(9); // 150 ms
/** Parked: nothing leaves the ground yet, so no ledge can grant it (A5's belfry). */
export const COYOTE = f(6); // 100 ms

// ------------------------------------------------------------------ attack
export interface AttackFrames {
  windup: number;
  active: number;
  recovery: number;
  /** Portion of recovery (from its start) during which a roll may cancel. */
  rollCancelFrom: number;
  damage: number;
  hitstop: number;
  knockback: number;
  /** Half-angle of the damage arc, radians. */
  arc: number;
  reach: number;
}

export const LIGHT_ATK: AttackFrames = {
  windup: f(7),
  active: f(5),
  recovery: f(12),
  rollCancelFrom: 0, // roll-cancellable for the whole recovery
  damage: 1,
  hitstop: f(4),
  knockback: 2.0,
  arc: Math.PI * 0.42,
  reach: 1.9,
};

export const HEAVY_ATK: AttackFrames = {
  windup: f(24),
  active: f(6),
  recovery: f(18),
  rollCancelFrom: f(6),
  damage: 3,
  hitstop: f(7),
  knockback: 3.2,
  arc: Math.PI * 0.55,
  reach: 2.3,
};

/** Combo: next attack may be buffered during active+recovery of the current one. */
export const COMBO_WINDOW_FROM = f(7); // frames into the attack
export const STICK_COMBO_LENGTH = 2;
export const SWORD_COMBO_LENGTH = 3;

// ------------------------------------------------------------------ hitstop
export const HITSTOP_LIGHT = f(4);
export const HITSTOP_HEAVY = f(7);
export const HITSTOP_KILL = f(7);

// ----------------------------------------------------------------- weapons
export type WeaponId = 'stick' | 'sword';

export interface WeaponDef {
  id: WeaponId;
  label: string;
  /** One entry per swing of the combo; the last one is the finisher. */
  swings: readonly AttackFrames[];
  /** A4's bramble only yields to an edge. */
  cutsBramble: boolean;
}

/** Found in hand. Short, quick, and honest about being a stick. */
const STICK_SWINGS: readonly AttackFrames[] = [
  LIGHT_ATK,
  {
    ...LIGHT_ATK,
    windup: f(6),
    recovery: f(14),
    knockback: 2.4,
    arc: Math.PI * 0.46,
    reach: 2.0,
  },
];

/** Longer, faster to re-swing, and the third blow actually moves things. */
const SWORD_SWINGS: readonly AttackFrames[] = [
  { ...LIGHT_ATK, windup: f(6), recovery: f(11), damage: 2, reach: 2.2 },
  {
    ...LIGHT_ATK,
    windup: f(5),
    recovery: f(12),
    damage: 2,
    knockback: 2.4,
    reach: 2.3,
  },
  {
    ...HEAVY_ATK,
    windup: f(9),
    recovery: f(18),
    damage: 3,
    arc: Math.PI * 0.6,
    reach: 2.5,
  },
];

export const WEAPONS: Readonly<Record<WeaponId, WeaponDef>> = {
  stick: {
    id: 'stick',
    label: 'Stick',
    swings: STICK_SWINGS,
    cutsBramble: false,
  },
  sword: {
    id: 'sword',
    label: 'Sword',
    swings: SWORD_SWINGS,
    cutsBramble: true,
  },
};

export const STARTING_WEAPON: WeaponId = 'stick';

// ------------------------------------------------------------------- shake
/** Screenshake is trauma-squared, Perlin-driven, ROTATIONAL-ONLY in 3D. */
export const SHAKE_MAX_OFFSET = 0.4; // u, camera-plane
export const SHAKE_MAX_ROLL = (1.5 * Math.PI) / 180; // rad
export const SHAKE_DECAY = 1.2; // trauma per second
export const SHAKE_FREQ = 18; // Hz
export const SHAKE_CAP = 1.0;
export const TRAUMA_HIT = 0.2;
export const TRAUMA_PLAYER_HURT = 0.4;
export const TRAUMA_BOSS_SLAM = 0.6;

// --------------------------------------------------------------- knockback
export const KNOCKBACK_SMALL_ENEMY = 2.0; // u
export const KNOCKBACK_PLAYER = 1.2; // u
export const PLAYER_HITSTUN = 0.25; // s
export const PLAYER_IFRAMES_AFTER_HIT = 0.6; // s
/**
 * How long a struck regular enemy is staggered - the sibling of PLAYER_HITSTUN
 * on the other side of the exchange. Section 5 names the player's number and
 * TONGUE_YANK_STAGGER but not this one; it is added here rather than aliased
 * inside an entity, so retuning the player's stun cannot silently retune every
 * enemy in the game (section 12).
 */
export const ENEMY_STAGGER = f(15); // 0.25 s

// ------------------------------------------------------------------ tongue
export const TONGUE_RANGE = 7.0; // u
export const TONGUE_EXTEND_SPEED = 35.0; // u/s
export const TONGUE_RETRACT_SPEED = 25.0; // u/s
export const TONGUE_WHIFF_RECOVERY = f(15);
export const TONGUE_PULL_SELF_SPEED = 18.0; // u/s
export const TONGUE_YANK_DISTANCE = 1.5; // u
export const TONGUE_YANK_STAGGER = f(40);
/** Elastic overshoot on extend, then settle. */
export const TONGUE_OVERSHOOT = 0.05;
/** A held body, thrown. It hurts whatever it lands on, and itself. */
export const TONGUE_THROW_SPEED = 14.0; // u/s
export const TONGUE_THROW_DAMAGE = 2;
export const TONGUE_THROW_RANGE = 5.0; // u before it tumbles to a stop
/**
 * The arrival slash: attacking while being hauled in converts the momentum
 * into a blow. The most-praised interaction in this genre (Death's Door), so
 * it is a first-class window rather than a coincidence of timing.
 */
export const LUNGE_SLASH_WINDOW = f(12);
export const LUNGE_SLASH_DAMAGE = 3;
export const LUNGE_SLASH_ARC = Math.PI * 0.7;
export const LUNGE_SLASH_REACH = 2.6;

/**
 * The blow itself: almost no windup, because the wind-up was the flight. It
 * exists as frame data so it obeys exactly the same strike path as a sword
 * swing rather than being a special case in the player.
 */
export const LUNGE_SLASH: AttackFrames = {
  windup: f(2),
  active: f(6),
  recovery: f(14),
  rollCancelFrom: 0,
  damage: LUNGE_SLASH_DAMAGE,
  hitstop: HITSTOP_HEAVY,
  knockback: 3.4,
  arc: LUNGE_SLASH_ARC,
  reach: LUNGE_SLASH_REACH,
};

// ------------------------------------------------------------------ lock-on
export const LOCKON_CONE = (60 * Math.PI) / 180; // half-cone from facing
export const LOCKON_RANGE = 9.0; // u
export const LOCKON_DROP_RANGE = 12.0; // u
export const LOCKON_OCCLUSION_DROP = 1.0; // s
export const MAGNETIZE_LUNGE = 1.5; // u max

// ------------------------------------------------------------------ squash
export const SQUASH_IMPACT = 0.88;
export const SQUASH_HOP = 1.15;
export const SQUASH_RECOVER = 9.0; // spring rate back to 1.0

// ------------------------------------------------------------------- audio
export const SFX_PITCH_VARIANCE = 0.06; // +/- 6% on every repeated sound

// ------------------------------------------------------------------ health
export const PLAYER_HP_MAX = 6;
/** Coins lost on death, left as a ghost where you fell. You get one try back. */
export const DEATH_COIN_DROP = 20;
/** How long the frog lies there before the last shrine takes it back. */
export const RESPAWN_DELAY = 1.2; // s

// ------------------------------------------------------------------ camera
/** Orthographic, immutable to the player. Pitch/yaw are authored per zone. */
export const CAM_PITCH = (-40 * Math.PI) / 180;
export const CAM_YAW = (45 * Math.PI) / 180;
/** Vertical frustum height in world units - this is the zoom control. */
export const CAM_VIEW_HEIGHT = 14.0;
export const CAM_DISTANCE = 40.0; // pull-back along the view axis (ortho: framing only)
/** Damped follow: fraction of remaining distance closed per second. */
export const CAM_FOLLOW_LAMBDA = 6.0;
/** Lock-on tilts the camera slightly higher. */
export const CAM_LOCKON_PITCH_DELTA = (-3 * Math.PI) / 180;
/** How fast that tilt settles: exp(-15 * 0.2 s) leaves ~5% of the delta. */
export const CAM_LOCKON_LAMBDA = 15.0;
export const CAM_NEAR = 0.1;
export const CAM_FAR = 200;

// ------------------------------------------------------------------ enemies
export const ENEMY_TELEGRAPH_MIN = f(36); // 600 ms, with flash + audio at windup start

export interface EnemyStats {
  hp: number;
  moveSpeed: number;
  aggroRange: number;
  /** Distance at which it commits to an attack. */
  attackRange: number;
  telegraph: number;
  active: number;
  recovery: number;
  damage: number;
  /** Mass class drives the tongue's mass rule. */
  mass: 'light' | 'medium' | 'heavy';
}

export const SPORELING: EnemyStats = {
  hp: 2,
  moveSpeed: 2.4,
  aggroRange: 8.0,
  attackRange: 1.3,
  telegraph: ENEMY_TELEGRAPH_MIN,
  active: f(8),
  recovery: f(28),
  damage: 1,
  mass: 'light',
};

/** Slower, tougher, and it hides behind a shield until you get around it. */
export const BEETLE_GUARD: EnemyStats = {
  hp: 5,
  moveSpeed: 1.8,
  aggroRange: 9.0,
  attackRange: 1.8,
  telegraph: f(44),
  active: f(10),
  recovery: f(34),
  damage: 2,
  mass: 'medium',
};
/**
 * Half-angle of the shield: a blow landing inside this cone off the guard's
 * facing is turned aside. A2 answers it by flanking; A3's tongue yank spins the
 * guard around and opens it from the front (section 4's medium row).
 */
export const BEETLE_SHIELD_ARC = (75 * Math.PI) / 180;
/**
 * Deliberately slower than the frog can strafe around it at attack range - the
 * shield is beatable by footwork, and that is the whole lesson of the fight.
 * It stops turning entirely once committed to a telegraph.
 */
export const BEETLE_TURN_RATE = 2.2; // rad/s
/** A turned blow bounces the attacker instead of hurting the guard. */
export const BEETLE_BLOCK_KNOCKBACK = 1.6;
export const BEETLE_BLOCK_TRAUMA = 0.12;
export const BEETLE_BLOCK_HITSTOP = f(3);

/** Ranged, hovers over water, and drops out of the air to a tongue. */
export const SPITTER_FLY: EnemyStats = {
  hp: 2,
  moveSpeed: 2.0,
  aggroRange: 11.0,
  attackRange: 8.0,
  telegraph: f(40),
  active: f(6),
  recovery: f(40),
  damage: 1,
  mass: 'light',
};
/** It keeps this far off, which is what makes it a tongue problem. */
export const SPITTER_STANDOFF = 5.5; // u
export const SPITTER_HOVER = 1.15; // u above the ground
export const GLOB_SPEED = 9.0; // u/s
export const GLOB_RANGE = 12.0; // u
export const GLOB_RADIUS = 0.18; // u
export const COIN_DROP_SPITTER = 5;
/** What a secret with no unique item in it is worth. */
export const SECRET_COINS = 12;

// ------------------------------------------------------------------- coins
export const COIN_DROP_SPORELING = 4;
export const COIN_DROP_BEETLE = 9;
/** Loose coins drift to the frog once it is this close, then land. */
export const COIN_MAGNET_RANGE = 1.8;
export const COIN_MAGNET_SPEED = 9.0;
export const COIN_PICKUP_RANGE = 0.55;
/** Coins are inert for a beat so a kill's spray cannot be collected mid-air. */
export const COIN_SETTLE = 0.35;

// ------------------------------------------------------- gates and secrets
/** Bramble only yields to an edge, so it is a lock the Sword is the key to. */
export const BRAMBLE_HP = 3;
/** How close the frog must be to open the belfry door, holding the key. */
export const DOOR_INTERACT_RANGE = 2.4;

// ------------------------------------------------------------------ shrines
export const SHRINE_INTERACT_RANGE = 2.2;

// ------------------------------------------------------------------ physics
export const PLAYER_RADIUS = 0.36;
export const PLAYER_HEIGHT = 1.0; // total capsule height
export const GRAVITY = -22.0; // u/s^2
/**
 * Falling speed cap. Nothing in Lilypond Downs falls far enough to reach it,
 * but the solver only substeps a fixed number of times per frame, so a long
 * drop (A5's three-floor belfry, A6's rooftop) would eventually out-run the
 * capsule sweep and tunnel. Cheaper as a rule than as a bug.
 */
export const TERMINAL_VELOCITY = -30.0; // u/s
export const MAX_SLOPE = (50 * Math.PI) / 180;
export const STEP_HEIGHT = 0.35;
export const GROUND_SNAP = 0.3;

// --------------------------------------------------------------------- rng
/** Fixed seed keeps spawns/drops deterministic. */
export const DEFAULT_SEED = 0x0c20a4;

// ------------------------------------------------------------------ render
export const DPR_CAP = 2;
export const SHADOW_MAP_SIZE = 2048;
/** Shadow frustum follows the player; tight fit is what keeps iso shadows crisp. */
export const SHADOW_EXTENT = 15.0; // half-size, so 30x30 u
export const SHADOW_NORMAL_BIAS = 0.02;
export const SHADOW_BIAS = -0.0005;
export const FOG_NEAR = 26;
export const FOG_FAR = 70;
/** Additive vertical screen gradient strength (PROMPT.md section 8). */
export const SCREEN_GRADIENT_STRENGTH = 0.12;
