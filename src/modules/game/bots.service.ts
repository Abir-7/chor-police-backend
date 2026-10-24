import { Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { Server } from 'socket.io';

import { GameService } from './game.service.js';
import { GamePhase, GameState } from './game.types.js';
import { GameRole } from './game-role.enum.js';
import { ALLOWED_REACTIONS } from '../chat/reactions.js';

/**
 * The gateway turns these callbacks into the same service calls + socket
 * emissions that a real player's socket message would trigger, so a bot
 * action lands in the room exactly like a human action.
 */
export interface BotActionHandlers {
  pickPaper: (roomCode: string, playerId: string, paperId: string) => void;
  selectTarget: (
    roomCode: string,
    playerId: string,
    targetRole: GameRole.CHOR | GameRole.DAKAT,
  ) => void;
  guessPlayer: (
    roomCode: string,
    playerId: string,
    selectedPlayerId: string,
  ) => void;
}

/** Bots take their turn after this "thinking" window. */
const BOT_THINK_MS = 1200;
/** Extra random thinking time so several bots never act identically. */
const BOT_THINK_JITTER_MS = 2200;
/** Per-bot stagger so bots rarely pick in the same instant. */
const BOT_STAGGER_MS = 400;
/** Babu and the Police "think" like a human decision: 10-12 seconds. */
const BOT_DECIDE_MIN_MS = 10000;
const BOT_DECIDE_MAX_MS = 12000;

const TOTAL_REACTION_CHANCE = 0.45;
const REACTION_EXTRA_MS = 2400;

/** How long the bot Police's "target highlighted" beat lasts before the
 *  arrest resolves — double duty as the suspense the room gets to feel.
 *  Long enough that everyone notices whom the bot Police is pointing at. */
const POLICE_ARREST_BEAT_MS = 3200;

// Round-end reactions depend on what the result means for that bot, so the
// room sees a believable mix instead of the same four emojis every round.
const CAUGHT_THIEF_REACTIONS = ['😭', '😱', '💀', '😂'];
const ESCAPED_THIEF_REACTIONS = ['🔥', '😎', '😂', '👍'];
const POLICE_SUCCESS_REACTIONS = ['👑', '🕵️', '👍', '🥳'];
const POLICE_FAILURE_REACTIONS = ['😕', '🤫', '👀', '😤'];
const RAJA_SUCCESS_REACTIONS = ['👑', '🥳', '👍'];
const RAJA_FAILURE_REACTIONS = ['😕', '🤫', '😤'];
const INNOCENT_SUCCESS_REACTIONS = ['🔥', '👏', '👍'];
const INNOCENT_FAILURE_REACTIONS = ['😂', '🤝', '😕'];
/** Babu's public command: nothing secret is given away by these. */
const BABU_COMMAND_REACTIONS = ['👑', '🤫', '🕵️'];

/** Role reveal: Babu and Police are public, suspects stay quiet on purpose. */
const REVEAL_RAJA_REACTIONS = ['👑', '🥳'];
const REVEAL_POLICE_REACTIONS = ['🕵️', '🤫', '👀'];
const REVEAL_INNOCENT_REACTIONS = ['👀', '😂', '👍', '😱'];
/** Watching slips disappear from the table — role-blind by design. */
const PAPER_PICK_REACTIONS = ['👀', '😂', '🤫', '👍'];
/** Babu has named the thief the Police must catch. */
const TARGET_SELECTED_REACTIONS = ['😱', '👀', '🔥', '🤫'];
/** The Police is hovering over a suspect. */
const SUSPECT_SELECTED_REACTIONS = ['👀', '😱', '🤫'];
/** While the Police keeps everyone waiting. */
const POLICE_THINKING_REACTIONS = ['😤', '👀', '😂', '⏳'];
const MATCH_WIN_REACTIONS = ['🥳', '👑', '🔥', '👏'];
const MATCH_LOSE_REACTIONS = ['😭', '😤', '🤝', '💀'];

interface BotReaction {
  senderId: string;
  senderName: string;
  reaction: string;
  timestamp: string;
}

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  private server?: Server;
  private handlers?: BotActionHandlers;

  constructor(
    private readonly gameService: GameService,
  ) {
    // GameService owns all game state; bot turns are scheduled against it.
  }

  /** roomCode -> live bot timers, so a room's pending turns can be cleared. */
  private readonly roomTimers = new Map<string, Set<NodeJS.Timeout>>();
  /** Dedupes scheduled bot actions across re-runs of the scheduler. */
  private readonly scheduledActions = new Map<string, Set<string>>();
  /** Makes every spontaneous reaction timer key unique. */
  private reactionSequence = 0;
  /** Rooms where a human is disconnected: bots must not advance the game. */
  private readonly pausedRooms = new Set<string>();

  setServer(server: Server): void {
    this.server = server;
  }

  setHandlers(handlers: BotActionHandlers): void {
    this.handlers = handlers;
  }

  /** A human dropped out: freeze every pending bot action in the room. */
  pause(roomCode: string): void {
    this.pausedRooms.add(roomCode);
    this.clearTimers(roomCode);
  }

  /** Everyone is back: re-schedule whatever the bots still owe. */
  resume(roomCode: string): void {
    if (!this.pausedRooms.delete(roomCode)) {
      return;
    }

    this.scheduleTurns(roomCode);
  }

  /** Called when a fresh round/match starts: reset timers, kick bot turns off. */
  onRoundStarted(roomCode: string): void {
    this.pausedRooms.delete(roomCode);
    this.clearTimers(roomCode);
    this.scheduleTurns(roomCode);
    this.scheduleRoundStartReaction(roomCode);
  }

  /**
   * Re-evaluates pending bot actions. Idempotent: call after every state
   * change (human or bot) so newly opened phases get bot turns scheduled.
   */
  onGameStateAdvanced(roomCode: string): void {
    this.scheduleTurns(roomCode);
  }

  /** Public roles just opened: Babu and Police gloat, citizens gasp. */
  onRolesRevealed(roomCode: string): void {
    this.reactWithBots(roomCode, 50, (bot) => {
      if (bot.role === GameRole.RAJA) {
        return REVEAL_RAJA_REACTIONS;
      }

      if (bot.role === GameRole.POLICE) {
        return REVEAL_POLICE_REACTIONS;
      }

      if (bot.role === GameRole.CHOR || bot.role === GameRole.DAKAT) {
        // Their role is still masked publicly: any emoji here could leak it.
        return null;
      }

      return REVEAL_INNOCENT_REACTIONS;
    });
  }

  /** Someone (human or bot) took a slip: the table notices, role-blind. */
  onPlayerPicked(roomCode: string): void {
    this.reactWithBots(roomCode, 30, () => PAPER_PICK_REACTIONS, 1);
  }

  /** Babu named the target thief: suspense ripples through the room. */
  onTargetSelected(roomCode: string): void {
    this.reactWithBots(roomCode, 45, () => TARGET_SELECTED_REACTIONS, 2);
  }

  /** The Police is hovering over a suspect right now. */
  onSuspectSelected(roomCode: string): void {
    this.reactWithBots(roomCode, 20, () => SUSPECT_SELECTED_REACTIONS, 1);
  }

  /** The Police is taking a while: someone in the room gets impatient. */
  onPoliceThinking(roomCode: string): void {
    this.reactWithBots(roomCode, 25, () => POLICE_THINKING_REACTIONS, 1);
  }

  /**
   * Called right after a round result (or match end) is broadcast: bots chip
   * in with an emotional reaction, like players do after a catch or a miss.
   */
  onRoundEnded(
    roomCode: string,
    caught: boolean,
    reactionChancePercent = 30,
  ): void {
    const game = this.gameService.getGameState(roomCode);

    if (!game) {
      return;
    }

    // Match over: celebrate the winner, groan for everyone else.
    if (game.phase === GamePhase.GAME_OVER) {
      this.reactWithBots(
        roomCode,
        85,
        (bot) =>
          bot.id === game.winnerPlayerId
            ? MATCH_WIN_REACTIONS
            : MATCH_LOSE_REACTIONS,
        3,
      );
      return;
    }

    const bots = game.players.filter((player) => player.isBot);

    for (const bot of bots) {
      if (randomInt(100) >= reactionChancePercent) {
        continue;
      }

      const pool = this.roundEndReactionPool(game, bot, caught);

      this.scheduleTimer(
        roomCode,
        `reaction:${bot.id}:round-end`,
        800 + randomInt(REACTION_EXTRA_MS),
        () => this.emitReaction(roomCode, bot.id, pool),
      );
    }
  }

  /**
   * Picks a reaction that fits the bot's own part in the round: a caught
   * thief groans, an escaped one gloats, and the Police celebrate or sulk.
   */
  private roundEndReactionPool(
    game: GameState,
    bot: { id: string; role?: GameRole },
    caught: boolean,
  ): string[] {
    const wasArrested = game.selectedPlayerId === bot.id;

    if (wasArrested && caught) {
      return CAUGHT_THIEF_REACTIONS;
    }

    if (bot.role === GameRole.CHOR || bot.role === GameRole.DAKAT) {
      return ESCAPED_THIEF_REACTIONS;
    }

    if (bot.role === GameRole.POLICE) {
      return caught ? POLICE_SUCCESS_REACTIONS : POLICE_FAILURE_REACTIONS;
    }

    if (bot.role === GameRole.RAJA) {
      return caught ? RAJA_SUCCESS_REACTIONS : RAJA_FAILURE_REACTIONS;
    }

    return caught ? INNOCENT_SUCCESS_REACTIONS : INNOCENT_FAILURE_REACTIONS;
  }

  /** Cancels every pending bot timer for a room (abort, lobby, room empty). */
  clearTimers(roomCode: string): void {
    const timers = this.roomTimers.get(roomCode);

    if (timers) {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      this.roomTimers.delete(roomCode);
    }

    this.scheduledActions.delete(roomCode);
  }

  /**
   * Walks the current game state and schedules any action a bot still owes:
   * picking a paper (PICKING), Babu's target pick (ROLE_REVEAL) and the
   * Police arrest (GUESSING).
   */
  private scheduleTurns(roomCode: string): void {
    const game = this.gameService.getGameState(roomCode);

    if (!game) {
      this.clearTimers(roomCode);
      return;
    }

    if (game.phase === GamePhase.PICKING) {
      let staggerIndex = 0;

      for (const bot of game.players) {
        if (!bot.isBot || bot.hasPicked) {
          continue;
        }

        this.scheduleTimer(
          roomCode,
          `pick:${bot.id}`,
          this.botDelay(staggerIndex),
          () => this.runBotPick(roomCode, bot.id),
        );

        staggerIndex += 1;
      }
    }

    if (game.phase === GamePhase.ROLE_REVEAL) {
      const raja = game.players.find(
        (player) => player.role === GameRole.RAJA,
      );

      if (raja?.isBot && !game.targetRole) {
        this.scheduleTimer(
          roomCode,
          `target:${raja.id}`,
          this.decideDelay(),
          () => this.runBotSelectTarget(roomCode, raja.id),
        );
      }
    }

    if (game.phase === GamePhase.GUESSING) {
      const police = game.players.find(
        (player) => player.role === GameRole.POLICE,
      );

      if (!game.selectedPlayerId) {
        // Someone in the room gets impatient while the arrest is pending —
        // works for a bot Police and for a human who is taking their time.
        this.scheduleTimer(
          roomCode,
          'reaction:police-thinking',
          3500 + randomInt(2000),
          () => this.onPoliceThinking(roomCode),
        );
      }

      if (police?.isBot && !game.selectedPlayerId) {
        this.scheduleTimer(
          roomCode,
          `guess:${police.id}`,
          this.decideDelay(),
          () => this.runBotGuess(roomCode, police.id),
        );
      }
    }
  }

  private botDelay(staggerIndex: number): number {
    return (
      BOT_THINK_MS +
      randomInt(BOT_THINK_JITTER_MS) +
      (staggerIndex > 0 ? staggerIndex * BOT_STAGGER_MS : 0)
    );
  }

  /** Babu's command and the Police arrest land somewhere in a 10-12s window. */
  private decideDelay(): number {
    return BOT_DECIDE_MIN_MS + randomInt(BOT_DECIDE_MAX_MS - BOT_DECIDE_MIN_MS);
  }

  private runBotPick(roomCode: string, botId: string): void {
    const game = this.gameService.getGameState(roomCode);

    if (!game || game.phase !== GamePhase.PICKING) {
      return;
    }

    const bot = game.players.find(
      (player) => player.id === botId && player.isBot && !player.hasPicked,
    );

    if (!bot) {
      return;
    }

    const availablePapers = game.papers.filter((paper) => !paper.selectedBy);

    if (availablePapers.length === 0) {
      return;
    }

    const paper = availablePapers[randomInt(availablePapers.length)];

    try {
      this.handlers?.pickPaper(roomCode, botId, paper.id);
      this.maybeReactAfterAction(roomCode, botId);
    } catch (error) {
      this.logBotFailure(roomCode, 'pick a paper', error);
    }
  }

  private runBotSelectTarget(roomCode: string, botId: string): void {
    const game = this.gameService.getGameState(roomCode);

    if (!game || game.phase !== GamePhase.ROLE_REVEAL || game.targetRole) {
      return;
    }

    // Babu cannot know which suspect holds which role: a fair 50/50 call.
    const targetRole = randomInt(2) === 0 ? GameRole.CHOR : GameRole.DAKAT;

    try {
      this.handlers?.selectTarget(roomCode, botId, targetRole);
      this.maybeReactAfterAction(roomCode, botId);
    } catch (error) {
      this.logBotFailure(roomCode, 'select a target', error);
    }
  }

  private runBotGuess(roomCode: string, botId: string): void {
    const game = this.gameService.getGameState(roomCode);

    if (!game || game.phase !== GamePhase.GUESSING || game.selectedPlayerId) {
      return;
    }

    // The Police only ever sees the two masked suspects: pick one at random.
    const suspects = game.players.filter(
      (player) => player.role === GameRole.CHOR || player.role === GameRole.DAKAT,
    );

    if (suspects.length === 0) {
      return;
    }

    const suspect = suspects[randomInt(suspects.length)];

    // Show the room whom the bot Police is pointing at BEFORE the arrest:
    // the same `game:police-selecting` highlight a human Police's picks
    // broadcast, so the target lights up for every player first. The
    // `autoConfirm` flag tells clients this pick will resolve by itself,
    // so they can play the Confirm-arrest button press for the room.
    this.server?.to(roomCode).emit('game:police-selecting', {
      selectedPlayerId: suspect.id,
      autoConfirm: true,
    });

    // A short beat so the highlight is actually seen, then the arrest lands.
    this.scheduleTimer(
      roomCode,
      `arrest:${botId}`,
      POLICE_ARREST_BEAT_MS,
      () => {
        const now = this.gameService.getGameState(roomCode);
        if (
          !now ||
          now.phase !== GamePhase.GUESSING ||
          now.selectedPlayerId
        ) {
          return;
        }
        try {
          this.handlers?.guessPlayer(roomCode, botId, suspect.id);
        } catch (error) {
          this.logBotFailure(roomCode, 'make an arrest', error);
        }
      },
    );
  }

  /**
   * Lets up to `maxBots` bots chime in with emojis from their own pool.
   * Pools can be null to keep that bot quiet (e.g. to avoid role leaks).
   */
  private reactWithBots(
    roomCode: string,
    chancePercent: number,
    poolFor: (bot: GameState['players'][number]) => string[] | null,
    maxBots = 2,
  ): void {
    if (!this.server) {
      return;
    }

    const game = this.gameService.getGameState(roomCode);

    if (!game) {
      return;
    }

    let sent = 0;

    for (const bot of game.players) {
      if (!bot.isBot || sent >= maxBots) {
        continue;
      }

      if (randomInt(100) >= chancePercent) {
        continue;
      }

      const pool = poolFor(bot);

      if (!pool || pool.length === 0) {
        continue;
      }

      sent += 1;
      this.reactionSequence += 1;

      this.scheduleTimer(
        roomCode,
        `reaction:${this.reactionSequence}:${bot.id}`,
        600 + randomInt(REACTION_EXTRA_MS),
        () => this.emitReaction(roomCode, bot.id, pool),
      );
    }
  }

  private maybeReactAfterAction(roomCode: string, botId: string): void {
    const game = this.gameService.getGameState(roomCode);
    const bot = game?.players.find((player) => player.id === botId);

    // Babu's target call is public, so a crown/secret-agent emoji reveals
    // nothing. Paper picks stay role-blind on purpose: reacting as the Raja
    // there would leak the bot's freshly drawn role to the whole room.
    const pool =
      bot?.role === GameRole.RAJA
        ? BABU_COMMAND_REACTIONS
        : [...ALLOWED_REACTIONS];

    this.scheduleBotReaction(roomCode, botId, TOTAL_REACTION_CHANCE, pool);
  }

  private scheduleRoundStartReaction(roomCode: string): void {
    this.scheduleBotReaction(roomCode, undefined, 0.6);
  }

  /**
   * Chance-based: one bot in the room sends a floating reaction after a
   * short delay, mirroring the chat gateway's `chat:reaction` payload.
   */
  private scheduleBotReaction(
    roomCode: string,
    botId: string | undefined,
    chance: number,
    pool?: string[],
  ): void {
    if (!this.server) {
      return;
    }

    const game = this.gameService.getGameState(roomCode);

    if (!game) {
      return;
    }

    const bots = game.players.filter((player) => player.isBot);

    if (bots.length === 0) {
      return;
    }

    if (randomInt(100) >= Math.round(chance * 100)) {
      return;
    }

    let botIdToUse = botId;

    if (!botIdToUse) {
      botIdToUse = bots[randomInt(bots.length)].id;
    } else {
      // The acting bot is gone (or never was a bot): fall back or skip quietly.
      const botExists = bots.some((bot) => bot.id === botIdToUse);

      if (!botExists) {
        botIdToUse = bots[randomInt(bots.length)].id;
      }
    }

    this.scheduleTimer(
      roomCode,
      `reaction:${botIdToUse}:${Date.now()}`,
      800 + randomInt(REACTION_EXTRA_MS),
      () => this.emitReaction(roomCode, botIdToUse!, pool ?? [...ALLOWED_REACTIONS]),
    );
  }

  private emitReaction(roomCode: string, botId: string, pool: string[]): void {
    if (!this.server) {
      return;
    }

    const game = this.gameService.getGameState(roomCode);
    const bot = game?.players.find(
      (player) => player.id === botId && player.isBot,
    );

    if (!bot) {
      return;
    }

    const payload: BotReaction = {
      senderId: bot.id,
      senderName: bot.name,
      reaction: pool[randomInt(pool.length)],
      timestamp: new Date().toISOString(),
    };

    this.server.to(roomCode).emit('chat:reaction', payload);
  }

  private scheduleTimer(
    roomCode: string,
    action: string,
    delayMs: number,
    callback: () => void,
  ): void {
    // Frozen while a human is away; resume() re-schedules from game state.
    if (this.pausedRooms.has(roomCode)) {
      return;
    }

    const key = `${roomCode}:${action}`;

    let roomKeys = this.scheduledActions.get(roomCode);

    if (!roomKeys) {
      roomKeys = new Set<string>();
      this.scheduledActions.set(roomCode, roomKeys);
    }

    if (roomKeys.has(key)) {
      return;
    }

    roomKeys.add(key);

    let timers = this.roomTimers.get(roomCode);

    if (!timers) {
      timers = new Set<NodeJS.Timeout>();
      this.roomTimers.set(roomCode, timers);
    }

    const timer = setTimeout(() => {
      roomKeys!.delete(key);
      timers!.delete(timer);
      callback();
    }, delayMs);

    // Never keep the process alive just for a bot turn.
    timer.unref?.();

    timers.add(timer);
  }

  private logBotFailure(roomCode: string, action: string, error: unknown): void {
    this.logger.warn(
      `Bot in room ${roomCode} failed to ${action}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
