import * as THREE from 'three';
import { dist, type Visual } from '@gaime/core';
import { Interpolator, ServerClock } from '@gaime/core/client';
import { CAMERA, CameraRig, createBar, createLabel, createStage, EffectsLayer, EntityLayer, faceCamera, pickGround, setBar, setLabel, type Bar, type ModelLibrary, type Stage } from '@gaime/core/three';
import type { Enemy, Input, Player, World } from '../shared/types';
import { movePlayer, RULES } from '../shared/rules';

/** Three.js view of the world: interpolated remote entities, predicted local player, effects. */
export class Arena {
  readonly stage: Stage;
  readonly rig: CameraRig;
  private readonly clock = new ServerClock();
  private readonly tracks = new Interpolator(['angle']);
  private readonly players: EntityLayer<Player>;
  private readonly enemies: EntityLayer<Enemy>;
  private readonly effects: EffectsLayer;
  private readonly crystal: THREE.Group;
  private readonly crystalBar: Bar;
  private world?: World;
  /** Locally predicted position of our own character. */
  private local?: { x: number; z: number; angle: number };
  localId = '';
  input?: Input;

  constructor(container: HTMLElement, private readonly models: ModelLibrary) {
    this.stage = createStage({ container, background: '#0b0f14' });
    const { scene } = this.stage;
    this.rig = new CameraRig(this.stage.camera, { offset: CAMERA.topDown });
    scene.fog = new THREE.Fog('#0b0f14', 38, 80);

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
    scene.add(this.crystal);

    this.effects = new EffectsLayer(scene);
    this.players = new EntityLayer<Player>(scene, player => this.createPlayer(player), player => player.color);
    this.enemies = new EntityLayer<Enemy>(scene, enemy => this.createEnemy(enemy), enemy => `${enemy.kind}:${JSON.stringify(this.enemyEntry(enemy.kind)?.visual)}`);
    this.stage.onFrame(dt => this.frame(dt));
  }

  private enemyEntry(kind: string) {
    return this.world?.catalog.find(entry => entry.kind === 'enemies' && entry.id === kind);
  }

  private createPlayer(player: Player) {
    const root = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.8, 6, 16), new THREE.MeshStandardMaterial({ color: player.color, roughness: 0.4, transparent: true }));
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
    const entry = this.enemyEntry(enemy.kind);
    const root = this.models.build((entry?.visual as Visual | undefined) ?? { shape: 'box', color: '#ff00ff' });
    const bar = createBar(Math.max(0.8, Number(entry?.radius ?? 0.6) * 1.4), '#ff7a59');
    bar.name = 'bar';
    bar.position.y = Math.max(1.2, new THREE.Box3().setFromObject(root).max.y + 0.35);
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
    this.effects.sync(world.effects);

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
  }

  private frame(dt: number) {
    const world = this.world;
    if (!world) return;
    const renderTime = this.clock.now();
    const camera = this.stage.camera;

    if (this.local && this.input) movePlayer(this.local, this.input, world.pause ? 0 : dt);

    this.players.forEach((object, player) => {
      const sample = player.id === this.localId && this.local ? this.local : this.tracks.sample(player.id, renderTime) ?? player;
      object.position.set(sample.x, 0, sample.z);
      const turn = object.getObjectByName('turn')!;
      turn.rotation.y = sample.angle;
      ((turn.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = player.respawnAt > 0 ? 0.25 : 1;
      setLabel(object.getObjectByName('label') as THREE.Sprite, `${world.hostId === player.id ? '👑 ' : ''}${player.data['gaime-bot'] ? '🤖 ' : ''}${player.name}`);
      const bar = object.getObjectByName('bar') as Bar;
      setBar(bar, player.hp / player.maxHp);
      faceCamera(bar, camera);
    });

    this.enemies.forEach((object, enemy) => {
      const sample = this.tracks.sample(enemy.id, renderTime) ?? enemy;
      object.position.set(sample.x, 0, sample.z);
      object.getObjectByName('body')!.rotation.y = sample.angle;
      const bar = object.getObjectByName('bar') as Bar;
      setBar(bar, enemy.hp / enemy.maxHp);
      bar.visible = enemy.hp < enemy.maxHp;
      faceCamera(bar, camera);
    });

    const gem = this.crystal.getObjectByName('gem')!;
    const health = world.crystal.hp / world.crystal.maxHp;
    gem.rotation.y += dt * (0.4 + (1 - health) * 2);
    gem.position.y = 2.2 + Math.sin(performance.now() / 600) * 0.15;
    ((gem as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive.setHSL(0.53 * health, 0.8, 0.35);
    setBar(this.crystalBar, health);
    faceCamera(this.crystalBar, camera);

    this.effects.update(renderTime);
    this.rig.update(this.local ?? world.players[this.localId] ?? { x: 0, z: 0 }, dt);
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
    this.effects.dispose();
    this.stage.dispose();
  }
}
