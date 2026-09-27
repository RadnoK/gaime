import * as THREE from 'three';
import { damp, dist } from '@gaime/core';
import { Interpolator, ServerClock } from '@gaime/core/client';
import { createLabel, createStage, EntityLayer, pickGround, setLabel, type ModelLibrary, type Stage } from '@gaime/core/three';
import type { Effect, Enemy, Input, Player, World } from '../shared/types';
import { movePlayer, RULES } from '../shared/rules';

const CAMERA_OFFSET = new THREE.Vector3(0, 23, 16);
const EFFECT_LIFE: Record<Effect['type'], number> = { tracer: 0.12, pulse: 0.45, hit: 0.35, spawn: 0.7, text: 1.1 };

type Bar = THREE.Group & { userData: { fill: THREE.Mesh; width: number } };

function createBar(width: number, color: string): Bar {
  const bar = new THREE.Group() as Bar;
  const plane = new THREE.PlaneGeometry(1, 1);
  const back = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.55, depthTest: false }));
  back.scale.set(width + 0.06, 0.16, 1);
  const fill = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color, depthTest: false }));
  fill.scale.set(width, 0.1, 1);
  fill.position.z = 0.001;
  back.renderOrder = 8; fill.renderOrder = 9;
  bar.add(back, fill);
  bar.userData = { fill, width };
  return bar;
}

function setBar(bar: Bar, value: number) {
  const { fill, width } = bar.userData;
  const k = Math.max(0.0001, Math.min(1, value));
  fill.scale.x = width * k;
  fill.position.x = -(width * (1 - k)) / 2;
}

/** Three.js view of the world: interpolated remote entities, predicted local player, effects. */
export class Arena {
  readonly stage: Stage;
  private readonly clock = new ServerClock();
  private readonly tracks = new Interpolator(['angle']);
  private readonly players: EntityLayer<Player>;
  private readonly enemies: EntityLayer<Enemy>;
  private readonly effects = new Map<number, { object: THREE.Object3D; effect: Effect }>();
  private readonly effectGroup = new THREE.Group();
  private readonly crystal: THREE.Group;
  private readonly crystalBar: Bar;
  private readonly cameraTarget = new THREE.Vector3();
  private world?: World;
  /** Locally predicted position of our own character. */
  private local?: { x: number; z: number; angle: number };
  localId = '';
  input?: Input;

  constructor(container: HTMLElement, private readonly models: ModelLibrary) {
    this.stage = createStage({ container, background: '#0b0f14' });
    const { scene, camera } = this.stage;
    scene.fog = new THREE.Fog('#0b0f14', 38, 80);
    camera.position.copy(CAMERA_OFFSET);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.HemisphereLight('#bcd7ff', '#1a1410', 1.1));
    const sun = new THREE.DirectionalLight('#ffffff', 2.2);
    sun.position.set(18, 30, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, far: 90 });
    scene.add(sun);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(RULES.arenaRadius, 96).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#1b2430', roughness: 0.95 }));
    ground.receiveShadow = true;
    const grid = new THREE.PolarGridHelper(RULES.arenaRadius, 16, 8, 96, '#2c3a4a', '#243140');
    grid.position.y = 0.01;
    const edge = new THREE.Mesh(new THREE.TorusGeometry(RULES.arenaRadius, 0.15, 8, 128).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#59e3ff', emissive: '#59e3ff', emissiveIntensity: 1.2 }));
    scene.add(ground, grid, edge);
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 3 + (i % 3), 1.2), new THREE.MeshStandardMaterial({ color: '#27313d', roughness: 0.8 }));
      pillar.position.set(Math.sin(angle) * (RULES.arenaRadius + 3), 1.5, Math.cos(angle) * (RULES.arenaRadius + 3));
      pillar.castShadow = true;
      scene.add(pillar);
    }

    this.crystal = new THREE.Group();
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(1.4), new THREE.MeshStandardMaterial({ color: '#59e3ff', emissive: '#1fa9d6', emissiveIntensity: 1.4, roughness: 0.2, metalness: 0.3, flatShading: true }));
    gem.name = 'gem';
    gem.position.y = 2.2;
    gem.castShadow = true;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(RULES.crystalRadius, RULES.crystalRadius + 0.3, 0.5, 24), new THREE.MeshStandardMaterial({ color: '#2a3542' }));
    base.position.y = 0.25;
    base.receiveShadow = true;
    const light = new THREE.PointLight('#59e3ff', 30, 18);
    light.position.y = 2.5;
    this.crystalBar = createBar(3, '#59e3ff');
    this.crystalBar.position.y = 4.4;
    this.crystal.add(gem, base, light, this.crystalBar);
    scene.add(this.crystal, this.effectGroup);

    this.players = new EntityLayer<Player>(scene, player => this.createPlayer(player), player => player.color);
    this.enemies = new EntityLayer<Enemy>(scene, enemy => this.createEnemy(enemy), enemy => `${enemy.kind}:${JSON.stringify(this.enemyVisual(enemy.kind))}`);
    this.stage.onFrame(dt => this.frame(dt));
  }

  private enemyVisual(kind: string) {
    return this.world?.catalog.find(entry => entry.kind === 'enemies' && entry.id === kind)?.visual as import('@gaime/core').Visual | undefined;
  }

  private createPlayer(player: Player) {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: player.color, roughness: 0.4, transparent: true });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.8, 6, 16), material);
    body.position.y = 0.8;
    body.castShadow = true;
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.8), new THREE.MeshStandardMaterial({ color: '#dfe7ef' }));
    gun.position.set(0.32, 0.95, 0.4);
    const turn = new THREE.Group();
    turn.name = 'turn';
    turn.add(body, gun);
    const label = createLabel(player.name, { background: 'rgba(0,0,0,0.45)' });
    label.name = 'label';
    label.position.y = 2.35;
    const bar = createBar(1.1, '#7dff9b');
    bar.name = 'bar';
    bar.position.y = 1.95;
    root.add(turn, label, bar);
    return root;
  }

  private createEnemy(enemy: Enemy) {
    const visual = this.enemyVisual(enemy.kind) ?? { shape: 'box', color: '#ff00ff' };
    const root = this.models.build(visual);
    const radius = Number(this.world?.catalog.find(entry => entry.kind === 'enemies' && entry.id === enemy.kind)?.radius ?? 0.6);
    const bar = createBar(Math.max(0.8, radius * 1.4), '#ff7a59');
    bar.name = 'bar';
    const box = new THREE.Box3().setFromObject(root);
    bar.position.y = Math.max(1.2, box.max.y + 0.35);
    root.add(bar);
    return root;
  }

  /** Called for every world received from the server. */
  update(world: World) {
    this.world = world;
    this.clock.sync(world.time);
    for (const player of Object.values(world.players)) this.tracks.push(player.id, world.time, { x: player.x, z: player.z, angle: player.angle });
    for (const enemy of Object.values(world.enemies)) this.tracks.push(enemy.id, world.time, { x: enemy.x, z: enemy.z, angle: enemy.angle });
    this.tracks.retain([...Object.keys(world.players), ...Object.keys(world.enemies)]);
    this.players.sync(Object.values(world.players).filter(player => player.online));
    this.enemies.sync(Object.values(world.enemies));

    const me = world.players[this.localId];
    if (me && !me.respawnAt) {
      if (!this.local || dist(this.local, me) > 2.5) this.local = { x: me.x, z: me.z, angle: me.angle };
      else {
        // Soft reconciliation: gentle while moving (the server lags behind), firm when standing.
        const moving = !!this.input && (this.input.mx !== 0 || this.input.mz !== 0);
        const k = moving ? 0.06 : 0.3;
        this.local.x += (me.x - this.local.x) * k;
        this.local.z += (me.z - this.local.z) * k;
      }
    } else this.local = undefined;

    for (const effect of world.effects) if (!this.effects.has(effect.id)) this.addEffect(effect);
  }

  private frame(dt: number) {
    const world = this.world;
    if (!world) return;
    const renderTime = this.clock.now(0.1);

    if (this.local && this.input) movePlayer(this.local, this.input, world.pause ? 0 : dt);

    this.players.forEach((object, player) => {
      const own = player.id === this.localId && this.local;
      const sample = own ? this.local! : this.tracks.sample(player.id, renderTime) ?? player;
      object.position.set(sample.x, 0, sample.z);
      object.getObjectByName('turn')!.rotation.y = sample.angle;
      const dead = player.respawnAt > 0;
      const body = (object.getObjectByName('turn')!.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
      body.opacity = dead ? 0.25 : 1;
      setLabel(object.getObjectByName('label') as THREE.Sprite, `${world.hostId === player.id ? '👑 ' : ''}${player.name}`);
      const bar = object.getObjectByName('bar') as Bar;
      setBar(bar, player.hp / player.maxHp);
      bar.quaternion.copy(this.stage.camera.quaternion);
    });

    this.enemies.forEach((object, enemy) => {
      const sample = this.tracks.sample(enemy.id, renderTime) ?? enemy;
      object.position.set(sample.x, 0, sample.z);
      object.getObjectByName('body')!.rotation.y = sample.angle;
      const bar = object.getObjectByName('bar') as Bar;
      setBar(bar, enemy.hp / enemy.maxHp);
      bar.visible = enemy.hp < enemy.maxHp;
      bar.quaternion.copy(this.stage.camera.quaternion);
    });

    const gem = this.crystal.getObjectByName('gem')!;
    const health = world.crystal.hp / world.crystal.maxHp;
    gem.rotation.y += dt * (0.4 + (1 - health) * 2);
    gem.position.y = 2.2 + Math.sin(performance.now() / 600) * 0.15;
    ((gem as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive.setHSL(0.53 * health, 0.8, 0.35);
    setBar(this.crystalBar, health);
    this.crystalBar.quaternion.copy(this.stage.camera.quaternion);

    this.animateEffects(renderTime);

    const focus = this.local ?? world.players[this.localId] ?? { x: 0, z: 0 };
    this.cameraTarget.lerp(new THREE.Vector3(focus.x, 0, focus.z), damp(6, dt));
    this.stage.camera.position.copy(this.cameraTarget).add(CAMERA_OFFSET);
    this.stage.camera.lookAt(this.cameraTarget);
  }

  private addEffect(effect: Effect) {
    const color = new THREE.Color(effect.color ?? '#ffffff');
    let object: THREE.Object3D;
    if (effect.type === 'tracer') {
      const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(effect.x, 0.95, effect.z), new THREE.Vector3(effect.x2 ?? effect.x, 0.95, effect.z2 ?? effect.z)]);
      object = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true }));
    } else if (effect.type === 'text') {
      object = createLabel(effect.text ?? '', { color: effect.color ?? '#ffffff' });
      object.position.set(effect.x, 2, effect.z);
    } else {
      const geometry = effect.type === 'hit' ? new THREE.SphereGeometry(0.5, 12, 8) : new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);
      object = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      object.position.set(effect.x, effect.type === 'hit' ? 0.8 : 0.05, effect.z);
    }
    object.visible = false;
    this.effectGroup.add(object);
    this.effects.set(effect.id, { object, effect });
  }

  private animateEffects(renderTime: number) {
    for (const [id, { object, effect }] of this.effects) {
      const life = EFFECT_LIFE[effect.type];
      const age = renderTime - effect.time;
      if (age > life || age < -1) {
        this.effectGroup.remove(object);
        (object as THREE.Mesh).geometry?.dispose();
        ((object as THREE.Mesh).material as THREE.Material)?.dispose();
        this.effects.delete(id);
        continue;
      }
      object.visible = age >= 0;
      const k = Math.max(0, age / life);
      const material = (object as THREE.Mesh).material as THREE.Material & { opacity: number };
      material.opacity = 1 - k;
      const radius = effect.radius ?? 1;
      if (effect.type === 'pulse') object.scale.setScalar(Math.max(0.01, radius * (0.2 + 0.8 * k)));
      if (effect.type === 'spawn') object.scale.setScalar(Math.max(0.01, radius * 2 * (1 - k)));
      if (effect.type === 'hit') object.scale.setScalar(radius * (0.6 + k));
      if (effect.type === 'text') object.position.y = 2 + k * 1.5;
    }
  }

  /** Ground point under the pointer (normalised device coordinates). */
  aim(ndcX: number, ndcY: number) {
    return pickGround(this.stage.camera, ndcX, ndcY, 0.9);
  }

  /** Position used for our own character (predicted when alive). */
  get me() { return this.local; }

  dispose() {
    this.players.dispose();
    this.enemies.dispose();
    this.stage.dispose();
  }
}
