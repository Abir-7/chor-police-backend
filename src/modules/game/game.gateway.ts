import { BadRequestException } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { GameService } from './game.service.js';
import { BotService } from './bots.service.js';
import { GamePhase, GameSettings } from './game.types.js';
import { GameRole } from './game-role.enum.js';
import { RoomsService } from '../rooms/rooms.service.js';

interface StartGamePayload {
  settings?: GameSettings;
}

interface PickPaperPayload {
  paperId: string;
}

interface SelectTargetPayload {
  targetRole: GameRole.CHOR | GameRole.DAKAT;
}

interface GuessPlayerPayload {
  selectedPlayerId: string;
}

interface SelectSuspectPayload {
  selectedPlayerId: string;
}

interface AllowNextRoundPayload {
  playerId: string;
}

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class GameGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit
{
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly gameService: GameService,
    private readonly roomsService: RoomsService,
    private readonly botService: BotService,
  ) {
    this.roomsService.setRoomEmptyHandler((roomCode: string) => {
      this.gameService.removeGame(roomCode);
      this.botService.clearTimers(roomCode);
    });

    this.roomsService.setRoomPlayersChangedHandler((roomCode: string) => {
      const hadGame = this.gameService.getGameState(roomCode) !== undefined;
      this.gameService.removeGame(roomCode);
      this.botService.clearTimers(roomCode);
      if (hadGame) {
        // Notify remaining players that the game was aborted
        this.server.to(roomCode).emit('game:aborted', {
          message: 'A player left the game. Returning to waiting room.',
        });
      }
    });

    this.roomsService.setGameActiveChecker((roomCode: string) => {
      return this.gameService.getGameState(roomCode) !== undefined;
    });

    this.roomsService.setPlayerDisconnectedHandler((roomCode: string) => {
      this.syncPauseState(roomCode);
    });

    this.roomsService.setPlayerReconnectedHandler(
      (roomCode: string, playerId: string) => {
        this.handlePlayerReconnectedGameSync(roomCode, playerId);
      },
    );

    // Bot decisions are executed through this gateway so a bot action emits
    // exactly the same events a real player's action would.
    this.botService.setHandlers({
      pickPaper: (roomCode, playerId, paperId) =>
        this.handleBotPickPaper(roomCode, playerId, paperId),
      selectTarget: (roomCode, playerId, targetRole) =>
        this.handleBotSelectTarget(roomCode, playerId, targetRole),
      guessPlayer: (roomCode, playerId, selectedPlayerId) =>
        this.handleBotGuess(roomCode, playerId, selectedPlayerId),
    });
  }

  afterInit(server: Server): void {
    this.botService.setServer(server);
  }

  handleConnection(client: Socket): void {
    console.log(`Game socket connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    console.log(`Game socket disconnected: ${client.id}`);
  }

  @SubscribeMessage('game:sync')
  handleGameSync(@ConnectedSocket() client: Socket): void {
    try {
      const { roomCode, playerId } = this.validateRoomMembership(client);

      // Explicit pull-based resync: the reconnect push can be lost in a
      // refresh race, so the client asks again after landing in the room.
      this.handlePlayerReconnectedGameSync(roomCode, playerId);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('game:start')
  handleStartGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload?: StartGamePayload,
  ): void {
    try {
      const { roomCode, playerId } = this.validateRoomMembership(client);

      const room = this.roomsService.getRoom(roomCode);

      if (room.hostId !== playerId) {
        throw new BadRequestException('Only the host can start the game.');
      }

      // A round may already be live (e.g. the client missed the reconnect
      // sync after a refresh). Pull the host back into the running game
      // instead of failing with 'A game is already in progress.'
      const existingGame = this.gameService.getGameState(roomCode);

      if (
        existingGame &&
        existingGame.phase !== GamePhase.ROUND_RESULT &&
        existingGame.phase !== GamePhase.GAME_OVER
      ) {
        this.handlePlayerReconnectedGameSync(roomCode, playerId);
        return;
      }

      this.validateConnectedPlayers(roomCode);

      this.gameService.startGame(
        roomCode,
        room.hostId,
        room.players.map((player) => ({
          id: player.id,
          name: player.name,
          isBot: player.isBot,
        })),
        payload?.settings,
      );

      this.server
        .to(roomCode)
        .emit('game:started', this.gameService.getPublicGameState(roomCode));

      this.botService.onRoundStarted(roomCode);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('game:pick-paper')
  handlePickPaper(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: PickPaperPayload,
  ): void {
    try {
      const { roomCode, playerId } = this.validateRoomMembership(client);

      this.validateGamePlayers(roomCode);

      if (!payload?.paperId) {
        throw new BadRequestException('Paper ID is required.');
      }

      this.gameService.pickPaper(roomCode, playerId, payload.paperId);

      const gameState = this.gameService.getPublicGameState(roomCode);

      this.server.to(roomCode).emit('game:state-updated', gameState);

      const state = this.gameService.getGameState(roomCode);

      if (state?.phase === GamePhase.ROLE_REVEAL) {
        // Broadcast the (masked) public reveal first so a failure while
        // sending one player's private role cannot stop everyone from
        // seeing the reveal screen.
        this.emitPublicRoleReveal(roomCode);
        this.emitPrivateRoles(roomCode);
        this.botService.onRolesRevealed(roomCode);
      }

      this.botService.onPlayerPicked(roomCode);
      this.botService.onGameStateAdvanced(roomCode);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('game:select-target')
  handleSelectTarget(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SelectTargetPayload,
  ): void {
    try {
      const { roomCode, playerId } = this.validateRoomMembership(client);

      this.validateGamePlayers(roomCode);

      if (
        payload?.targetRole !== GameRole.CHOR &&
        payload?.targetRole !== GameRole.DAKAT
      ) {
        throw new BadRequestException('Target role must be Chor or Dakat.');
      }

      this.gameService.selectTarget(roomCode, playerId, payload.targetRole);

      this.server.to(roomCode).emit('game:target-selected', {
        targetRole: payload.targetRole,
        gameState: this.gameService.getPublicGameState(roomCode),
      });

      this.botService.onTargetSelected(roomCode);
      this.botService.onGameStateAdvanced(roomCode);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('game:select-suspect')
  handleSelectSuspect(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SelectSuspectPayload,
  ): void {
    try {
      const { roomCode, playerId } = this.validateRoomMembership(client);
      this.validateGamePlayers(roomCode);

      const game = this.gameService.getGameState(roomCode);
      if (!game || game.phase !== GamePhase.GUESSING) {
        return;
      }

      const player = game.players.find((p) => p.id === playerId);
      if (!player || player.role !== GameRole.POLICE) {
        return;
      }

      this.server.to(roomCode).emit('game:police-selecting', {
        selectedPlayerId: payload?.selectedPlayerId,
      });

      this.botService.onSuspectSelected(roomCode);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('game:guess-player')
  handleGuessPlayer(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: GuessPlayerPayload,
  ): void {
    try {
      const { roomCode, playerId } = this.validateRoomMembership(client);

      this.validateGamePlayers(roomCode);

      if (!payload?.selectedPlayerId) {
        throw new BadRequestException('Selected player ID is required.');
      }

      this.processPoliceGuess(roomCode, playerId, payload.selectedPlayerId);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('game:allow-next-round')
  handleAllowNextRound(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: AllowNextRoundPayload,
  ): void {
    try {
      const { roomCode, playerId } = this.validateRoomMembership(client);

      this.validateGamePlayers(roomCode);

      if (!payload?.playerId) {
        throw new BadRequestException('Player ID is required.');
      }

      const room = this.roomsService.getRoom(roomCode);

      if (room.hostId !== playerId) {
        throw new BadRequestException(
          'Only the host can authorize the next round.',
        );
      }

      this.gameService.allowNextRound(roomCode, playerId, payload.playerId);

      this.server.to(roomCode).emit('game:next-round-permission', {
        playerId: payload.playerId,
      });
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('game:finish')
  handleFinishGame(@ConnectedSocket() client: Socket): void {
    try {
      const { roomCode, playerId } = this.validateRoomMembership(client);
      this.validateGamePlayers(roomCode);

      const game = this.gameService.finishMatch(roomCode, playerId);

      this.botService.clearTimers(roomCode);

      const payload = {
        phase: game.phase,
        winnerPlayerId: game.winnerPlayerId,
        players: game.players.map((player) => ({
          id: player.id,
          name: player.name,
          role: player.role,
          score: player.score,
          roundScore: player.roundScore,
        })),
        gameState: this.gameService.getPublicGameState(roomCode),
      };

      this.server.to(roomCode).emit('game:match-ended', payload);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }
  @SubscribeMessage('game:back-to-lobby')
  handleBackToLobby(@ConnectedSocket() client: Socket): void {
    try {
      const { roomCode, playerId } = this.validateRoomMembership(client);

      const room = this.roomsService.getRoom(roomCode);
      if (room.hostId !== playerId) {
        throw new BadRequestException('Only the host can return to the lobby.');
      }

      const game = this.gameService.getGameState(roomCode);
      if (game && game.phase !== GamePhase.GAME_OVER) {
        throw new BadRequestException('Cannot return to lobby while a game is in progress.');
      }

      this.gameService.removeGame(roomCode);
      this.botService.clearTimers(roomCode);

      this.server.to(roomCode).emit('game:back-to-lobby', {
        message: 'Host returned to lobby. Configure settings for the next match.',
      });
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('game:next-round')
  handleNextRound(@ConnectedSocket() client: Socket): void {
    try {
      const { roomCode, playerId } = this.validateRoomMembership(client);

      this.validateGamePlayers(roomCode);

      if (!this.gameService.canStartNextRound(roomCode, playerId)) {
        throw new BadRequestException(
          'Only the host or the authorized player can start the next round.',
        );
      }

      const room = this.roomsService.getRoom(roomCode);

      this.gameService.startGame(
        roomCode,
        room.hostId,
        room.players.map((player) => ({
          id: player.id,
          name: player.name,
          isBot: player.isBot,
        })),
      );

      this.server
        .to(roomCode)
        .emit('game:started', this.gameService.getPublicGameState(roomCode));

      this.botService.onRoundStarted(roomCode);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  private processPoliceGuess(
    roomCode: string,
    policeId: string,
    selectedPlayerId: string,
  ): void {
    const result = this.gameService.guessPlayer(
      roomCode,
      policeId,
      selectedPlayerId,
    );

    const game = this.gameService.getGameState(roomCode);

    if (!game) {
      throw new BadRequestException('Game not found.');
    }

    const payload = {
      ...result,
      phase: game.phase,
      winnerPlayerId: game.winnerPlayerId,
      players: game.players.map((player) => ({
        id: player.id,
        name: player.name,
        role: player.role,
        score: player.score,
        roundScore: player.roundScore,
      })),
      gameState: this.gameService.getPublicGameState(roomCode),
    };

    if (game.phase === GamePhase.GAME_OVER) {
      this.server.to(roomCode).emit('game:match-ended', payload);
    } else {
      this.server.to(roomCode).emit('game:round-result', payload);
    }

    // Bots react to the outcome, like players do after a catch or a miss.
    const arrested = game.players.find(
      (player) => player.id === selectedPlayerId,
    );
    const caught =
      !!arrested?.role &&
      !!game.targetRole &&
      arrested.role === game.targetRole;

    this.botService.onRoundEnded(roomCode, caught);
  }

  private handleBotPickPaper(
    roomCode: string,
    botId: string,
    paperId: string,
  ): void {
    this.gameService.pickPaper(roomCode, botId, paperId);

    const state = this.gameService.getGameState(roomCode);

    if (!state) {
      return;
    }

    this.server
      .to(roomCode)
      .emit('game:state-updated', this.gameService.getPublicGameState(roomCode));

    if (state.phase === GamePhase.ROLE_REVEAL) {
      this.emitPublicRoleReveal(roomCode);
      this.emitPrivateRoles(roomCode);
      this.botService.onRolesRevealed(roomCode);
    }

    this.botService.onGameStateAdvanced(roomCode);
  }

  private handleBotSelectTarget(
    roomCode: string,
    botId: string,
    targetRole: GameRole.CHOR | GameRole.DAKAT,
  ): void {
    this.gameService.selectTarget(roomCode, botId, targetRole);

    this.server.to(roomCode).emit('game:target-selected', {
      targetRole,
      gameState: this.gameService.getPublicGameState(roomCode),
    });

    this.botService.onTargetSelected(roomCode);
    this.botService.onGameStateAdvanced(roomCode);
  }

  private handleBotGuess(
    roomCode: string,
    botId: string,
    selectedPlayerId: string,
  ): void {
    this.processPoliceGuess(roomCode, botId, selectedPlayerId);
  }

  /**
   * Sends one atomic snapshot (state + this player's private role + pause
   * info) to a returning socket. The client replaces its whole game view with
   * it and skips every animation, so a refresh lands on the live board.
   */
  private handlePlayerReconnectedGameSync(
    roomCode: string,
    playerId: string,
  ): void {
    const socket = this.findSocketByPlayerId(roomCode, playerId);

    if (!socket) {
      return;
    }

    const game = this.gameService.getGameState(roomCode);

    if (!game) {
      // The match ended/aborted while this player was away: tell the client
      // to drop any stale board instead of leaving it frozen on old state.
      socket.emit('game:resync', { gameState: null, disconnected: [] });
      return;
    }

    const player = game.players.find((p) => p.id === playerId);
    let myRole: GameRole | undefined;
    let partnerThief: { id: string; name: string; role: GameRole } | undefined;

    // Roles exist from ROLE_REVEAL onward; before that there is nothing private.
    if (player?.role && game.phase !== GamePhase.PICKING) {
      myRole = player.role;

      const chorPlayer = game.players.find((p) => p.role === GameRole.CHOR);
      const dakatPlayer = game.players.find((p) => p.role === GameRole.DAKAT);

      if (player.role === GameRole.CHOR && dakatPlayer) {
        partnerThief = {
          id: dakatPlayer.id,
          name: dakatPlayer.name,
          role: GameRole.DAKAT,
        };
      } else if (player.role === GameRole.DAKAT && chorPlayer) {
        partnerThief = {
          id: chorPlayer.id,
          name: chorPlayer.name,
          role: GameRole.CHOR,
        };
      }
    }

    socket.emit('game:resync', {
      gameState: this.gameService.getPublicGameState(roomCode),
      myRole,
      partnerThief,
      disconnected: this.roomsService.getDisconnectedHumans(roomCode),
    });

    // Everyone else learns whether the table can carry on now.
    this.syncPauseState(roomCode);
  }

  /**
   * While a human seat is held open the round is frozen: their actions cannot
   * be taken and bots must not play on without them. Tell the room who we are
   * waiting for (and until when), or that play resumed.
   */
  private syncPauseState(roomCode: string): void {
    if (!this.gameService.getGameState(roomCode)) {
      return;
    }

    const disconnected = this.roomsService.getDisconnectedHumans(roomCode);

    if (disconnected.length > 0) {
      this.botService.pause(roomCode);
      this.server.to(roomCode).emit('game:paused', { disconnected });
      return;
    }

    this.server.to(roomCode).emit('game:resumed', {});
    this.botService.resume(roomCode);
  }

  private emitPrivateRoles(roomCode: string): void {
    const room = this.roomsService.getRoom(roomCode);
    const game = this.gameService.getGameState(roomCode);

    for (const player of room.players) {
      let role: GameRole | undefined;

      try {
        role = this.gameService.getMyRole(roomCode, player.id);
      } catch {
        // A player without an assigned role (or not in this game) must not
        // abort the loop — the other players still need their roles.
        continue;
      }

      const socket = this.findSocketByPlayerId(roomCode, player.id);

      let partnerThief: { id: string; name: string; role: GameRole } | undefined;
      if (game) {
        const chorPlayer = game.players.find((p) => p.role === GameRole.CHOR);
        const dakatPlayer = game.players.find((p) => p.role === GameRole.DAKAT);
        if (role === GameRole.CHOR && dakatPlayer) {
          partnerThief = { id: dakatPlayer.id, name: dakatPlayer.name, role: GameRole.DAKAT };
        } else if (role === GameRole.DAKAT && chorPlayer) {
          partnerThief = { id: chorPlayer.id, name: chorPlayer.name, role: GameRole.CHOR };
        }
      }
      socket?.emit('game:my-role', { role, partnerThief });
    }
  }

  private emitPublicRoleReveal(roomCode: string): void {
    const game = this.gameService.getGameState(roomCode);

    if (!game) {
      return;
    }

    const players = game.players.map((player) => ({
      id: player.id,
      name: player.name,
      role:
        player.role === GameRole.CHOR || player.role === GameRole.DAKAT
          ? 'CHOR_OR_DAKAT'
          : player.role,
    }));

    this.server.to(roomCode).emit('game:roles-revealed', {
      phase: game.phase,
      players,
    });
  }

  private findSocketByPlayerId(
    roomCode: string,
    playerId: string,
  ): Socket | undefined {
    return [...this.server.sockets.sockets.values()].find(
      (socket) =>
        socket.connected &&
        socket.data.roomCode === roomCode &&
        socket.data.playerId === playerId &&
        socket.rooms.has(roomCode),
    );
  }

  private validateRoomMembership(client: Socket): {
    roomCode: string;
    playerId: string;
  } {
    const roomCode = client.data.roomCode as string | undefined;
    const playerId = client.data.playerId as string | undefined;

    if (!roomCode || !playerId) {
      throw new BadRequestException('Join a room before playing.');
    }

    if (!client.rooms.has(roomCode)) {
      throw new BadRequestException(
        'You are no longer connected to this room.',
      );
    }

    const room = this.roomsService.getRoomIfExists(roomCode);

    if (!room || !room.players.some((player) => player.id === playerId)) {
      throw new BadRequestException('You are no longer a member of this room.');
    }

    const player = room.players.find((item) => item.id === playerId);

    if (!player?.isConnected) {
      throw new BadRequestException(
        'Your connection is inactive. Reconnect to continue.',
      );
    }

    const activeSocket = this.findSocketByPlayerId(roomCode, playerId);
    if (!activeSocket || activeSocket.id !== client.id) {
      throw new BadRequestException(
        'This connection is no longer active. Reconnect to continue.',
      );
    }
    return { roomCode, playerId };
  }

  private validateConnectedPlayers(roomCode: string): void {
    const room = this.roomsService.getRoom(roomCode);

    const disconnectedPlayers = room.players.filter(
      (player) => !player.isConnected,
    );

    if (disconnectedPlayers.length > 0) {
      throw new BadRequestException(
        `Waiting for disconnected players: ${disconnectedPlayers
          .map((player) => player.name)
          .join(', ')}.`,
      );
    }
  }

  private validateGamePlayers(roomCode: string): void {
    const room = this.roomsService.getRoom(roomCode);
    const game = this.gameService.getGameState(roomCode);

    if (!game) {
      throw new BadRequestException('Game not found.');
    }

    if (room.hostId !== game.hostId) {
      throw new BadRequestException(
        'The host cannot change during an active game session.',
      );
    }

    this.validateConnectedPlayers(roomCode);

    const gamePlayerIds = game.players.map((player) => player.id).sort();

    const roomPlayerIds = room.players.map((player) => player.id).sort();

    const samePlayers =
      gamePlayerIds.length === roomPlayerIds.length &&
      gamePlayerIds.every((id, index) => id === roomPlayerIds[index]);

    if (!samePlayers) {
      throw new BadRequestException(
        'The room player list has changed. Please resolve room membership first.',
      );
    }
  }

  private emitError(client: Socket, error: unknown): void {
    client.emit('game:error', {
      message: error instanceof Error ? error.message : 'Something went wrong.',
    });
  }
}
