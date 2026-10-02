import { registerRequest, type Protocol } from './codec.js'

// Helper: S32 / UTF / VS32 / Bool
const S = (n: string) => ({ name: n, kind: 'S32' as const })
const V = (n: string) => ({ name: n, kind: 'VS32' as const })
const U = (n: string) => ({ name: n, kind: 'UTF' as const })
const B = (n: string) => ({ name: n, kind: 'Bool' as const })

// ---- Auth / Lifecycle ----
registerRequest({ messageId: 0x00032001, name: 'ClientEnterServerRequest', fields: [U('c2s_accountUUID'), U('c2s_token'), B('c2s_debug'), S('c2s_sessionId')] })
registerRequest({ messageId: 0x00032002, name: 'ClientEnterServerResponse', fields: [S('s2c_sessionId')] })
registerRequest({ messageId: 0x00033001, name: 'ClientEnterGameRequest', fields: [
  U('c2s_accountUUID'), U('c2s_serverID'), S('c2s_LanguageID'), U('c2s_DeviceID'),
  U('c2s_Os'), U('c2s_OsVersion'), U('c2s_AppVersion'), U('c2s_ZoneOffset'),
  U('c2s_Channel'), U('c2s_AFID'), U('c2s_UseSource'), U('c2s_Address'),
  U('c2s_ClientVersion'), U('c2s_BundleID') ] })
registerRequest({ messageId: 0x00033002, name: 'ClientEnterGameResponse', fields: [
  U('s2c_UserSource'), B('s2c_newRole'), S('s2c_waitingCount'), U('s2c_battleRecordURLPrefix'),
  S('s2c_accumulativeLoginDays'), U('s2c_serverId'), U('s2c_createRoleClientVersion') ] })
registerRequest({ messageId: 0x0003300F, name: 'ClientExitGameRequest', fields: [U('c2s_accountUUID')] })
registerRequest({ messageId: 0x00035002, name: 'ClientBatchRequest', fields: [] }) // custom VS32(Obj[])
registerRequest({ messageId: 0x00050201, name: 'ClientGetRoleInfoRequest', fields: [U('c2s_serverid'), U('c2s_uuid'), S('c2s_type')] })
registerRequest({ messageId: 0x00050202, name: 'ClientGetRoleInfoResponse', fields: [] })
registerRequest({ messageId: 0x00050403, name: 'ClientChangeRoleNameRequest', fields: [U('c2s_name')] })

// ---- Player / Role ----
registerRequest({ messageId: 0x00050415, name: 'ClientHadChangeShowTeamNotify', fields: [] })
registerRequest({ messageId: 0x00035311, name: 'ClientRoleDataNotify', fields: [] })
registerRequest({ messageId: 0x00035312, name: 'ClientRoleHeadIconChangeNotify', fields: [] })
registerRequest({ messageId: 0x00035001, name: 'ClientCommonNotify', fields: [S('s2c_gainItemsReason')] })
registerRequest({ messageId: 0x00050101, name: 'ClientRoleExpChangeNotify', fields: [] })
registerRequest({ messageId: 0x00050413, name: 'ClientChangeGenderRequest', fields: [S('c2s_gender')] })
registerRequest({ messageId: 0x00050414, name: 'ClientChangeHeadIconRequest', fields: [U('c2s_iconId')] })
registerRequest({ messageId: 0x00050416, name: 'ClientChangeHeadIconBoxRequest', fields: [U('c2s_boxId')] })
registerRequest({ messageId: 0x00050417, name: 'ClientChangeSignRequest', fields: [U('c2s_sign')] })
registerRequest({ messageId: 0x00050418, name: 'ClientChangeShowPicturesAndHeroTeamRequest', fields: [U('c2s_pictures'), U('c2s_teamId')] })
registerRequest({ messageId: 0x00050419, name: 'ClientSetChangeShowTeamRequest', fields: [U('c2s_teamId')] })
registerRequest({ messageId: 0x00050420, name: 'ClientSetFirstRechargeShowRequest', fields: [B('c2s_shown')] })
registerRequest({ messageId: 0x00055001, name: 'ClientAccumulativeLoginDaysNotify', fields: [S('s2c_days')] })
registerRequest({ messageId: 0x0005500A, name: 'ClientBindPhoneRequest', fields: [U('c2s_phone'), U('c2s_code')] })
registerRequest({ messageId: 0x0005500B, name: 'ClientSendCodeByPhoneRequest', fields: [U('c2s_phone')] })
registerRequest({ messageId: 0x0005500C, name: 'ClientQueryUserPhoneRequest', fields: [] })
registerRequest({ messageId: 0x00055010, name: 'ClientUploadIPRequest', fields: [U('c2s_ip'), U('c2s_country')] })
registerRequest({ messageId: 0x00055011, name: 'ClientUpdateCurrencyCodeRequest', fields: [U('c2s_code')] })
registerRequest({ messageId: 0x00055012, name: 'ClientRecordLocalLanguageRequest', fields: [U('c2s_lang')] })
registerRequest({ messageId: 0x00055013, name: 'ClientGetServerTimeOffsetRequest', fields: [] })
registerRequest({ messageId: 0x00055014, name: 'ClientGetRoleListRequest', fields: [S('c2s_page')] })
registerRequest({ messageId: 0x00055015, name: 'ClientGetMultiRoleInfoRequest', fields: [U('c2s_uuids')] })

// ---- Hero (35) ----
for (let i = 0; i < 35; i++) registerRequest({ messageId: 0x00033010 + i, name: `ClientHeroRequest_${i}`, fields: [U('c2s_heroUuid'), S('c2s_op')] })

// ---- Equip / Item (19) ----
for (let i = 0; i < 19; i++) registerRequest({ messageId: 0x00033100 + i, name: `ClientEquipRequest_${i}`, fields: [U('c2s_heroUuid'), U('c2s_itemUuid')] })

// ---- Artifact / Hallows / Crystal (23) ----
for (let i = 0; i < 23; i++) registerRequest({ messageId: 0x00033200 + i, name: `ClientArtifactRequest_${i}`, fields: [U('c2s_id'), S('c2s_op')] })

// ---- Bag (1) ----
registerRequest({ messageId: 0x00033301, name: 'ClientQueryBagHeroRequest', fields: [] })

// ---- Formation (10) ----
for (let i = 0; i < 10; i++) registerRequest({ messageId: 0x00033400 + i, name: `ClientFormationRequest_${i}`, fields: [U('c2s_formationId')] })

// ---- Battle / Dungeon / Copy (42) ----
registerRequest({ messageId: 0x00035201, name: 'ClientFightRandomSeedRequest', fields: [S('FightMod'), S('StageId')] })
registerRequest({ messageId: 0x00035202, name: 'ClientFightResultRequest', fields: [U('c2s_battleId'), S('c2s_result')] })
registerRequest({ messageId: 0x00035203, name: 'ClientFightSkipResultRequest', fields: [U('c2s_battleId')] })
for (let i = 4; i < 42; i++) registerRequest({ messageId: 0x00035200 + i, name: `ClientBattleRequest_${i}`, fields: [U('c2s_id')] })

// ---- Arena (40) ----
for (let i = 0; i < 40; i++) registerRequest({ messageId: 0x00038E00 + i, name: `ClientArenaRequest_${i}`, fields: [S('c2s_type'), U('c2s_opponent')] })

// ---- Maze / Rogue (6) ----
registerRequest({ messageId: 0x00037901, name: 'ClientEnterMazeRequest', fields: [S('c2s_mazeType')] })
for (let i = 2; i < 7; i++) registerRequest({ messageId: 0x00037900 + i, name: `ClientMazeRequest_${i}`, fields: [S('c2s_op')] })

// ---- Guild (51) ----
for (let i = 0; i < 51; i++) registerRequest({ messageId: 0x00036000 + i, name: `ClientGuildRequest_${i}`, fields: [U('c2s_guildId')] })

// ---- Activity (56) ----
for (let i = 0; i < 56; i++) registerRequest({ messageId: 0x00040000 + i, name: `ClientActivityRequest_${i}`, fields: [S('c2s_type')] })

// ---- Sign-in / Login Reward (12) ----
for (let i = 0; i < 12; i++) registerRequest({ messageId: 0x00035600 + i, name: `ClientSignInRequest_${i}`, fields: [S('c2s_day')] })

// ---- Market / Shop (27) ----
for (let i = 0; i < 27; i++) registerRequest({ messageId: 0x00040500 + i, name: `ClientMarketRequest_${i}`, fields: [S('c2s_goodsId')] })

// ---- Chat (9) ----
for (let i = 0; i < 9; i++) registerRequest({ messageId: 0x00038300 + i, name: `ClientChatRequest_${i}`, fields: [U('c2s_text')] })

// ---- Mail (2) ----
registerRequest({ messageId: 0x00038501, name: 'ClientGetMailListRequest', fields: [] })
registerRequest({ messageId: 0x00038502, name: 'ClientOperateMailRequest', fields: [U('c2s_mailId'), S('c2s_op')] })

// ---- Friend / Mercenary (26) ----
for (let i = 0; i < 26; i++) registerRequest({ messageId: 0x00038000 + i, name: `ClientFriendRequest_${i}`, fields: [U('c2s_targetUuid')] })

// ---- Task / Reward (15) ----
for (let i = 0; i < 15; i++) registerRequest({ messageId: 0x00035500 + i, name: `ClientTaskRequest_${i}`, fields: [S('c2s_taskId')] })

// ---- Tavern (5) ----
for (let i = 0; i < 5; i++) registerRequest({ messageId: 0x00050000 + i, name: `ClientTavernRequest_${i}`, fields: [] })

// ---- Tower (4) ----
for (let i = 0; i < 4; i++) registerRequest({ messageId: 0x00035800 + i, name: `ClientTowerRequest_${i}`, fields: [] })

// ---- Wishlist (5) ----
for (let i = 0; i < 5; i++) registerRequest({ messageId: 0x00050300 + i, name: `ClientWishListRequest_${i}`, fields: [] })

// ---- WishSummon (11) ----
for (let i = 0; i < 11; i++) registerRequest({ messageId: 0x00050600 + i, name: `ClientWishSummonRequest_${i}`, fields: [] })

// ---- Union (9) ----
for (let i = 0; i < 9; i++) registerRequest({ messageId: 0x00037100 + i, name: `ClientUnionRequest_${i}`, fields: [] })

// ---- Pay (4) ----
registerRequest({ messageId: 0x00040101, name: 'ClientPlaceOrderRequest', fields: [U('c2s_goodsId'), S('c2s_count')] })
registerRequest({ messageId: 0x00040102, name: 'ClientPayRequest', fields: [U('c2s_orderId')] })
registerRequest({ messageId: 0x00040103, name: 'ClientCheckOrderRequest', fields: [U('c2s_orderId')] })
registerRequest({ messageId: 0x00040104, name: 'ClientSyncOrderRequest', fields: [U('c2s_orderId'), S('c2s_status')] })

// ---- RedDot (3) ----
for (let i = 0; i < 3; i++) registerRequest({ messageId: 0x00035300 + i, name: `ClientRedDotRequest_${i}`, fields: [U('c2s_id')] })

// ---- NewerGuide (1) ----
registerRequest({ messageId: 0x00050640, name: 'ClientNewerGuideSetProgressRequest', fields: [S('c2s_step')] })

// ---- VoidVisitor (3) ----
for (let i = 0; i < 3; i++) registerRequest({ messageId: 0x00050700 + i, name: `ClientVoidVisitorRequest_${i}`, fields: [] })

// ---- Community (1) ----
registerRequest({ messageId: 0x00050800, name: 'ClientJoinCommunityRequest', fields: [U('c2s_communityId')] })

// ---- HistoricalArchives (1) ----
registerRequest({ messageId: 0x00050900, name: 'ClientHistoricalArchivesListInfoRequest', fields: [] })

// ---- Debug (2) ----
for (let i = 0; i < 2; i++) registerRequest({ messageId: 0x00070000 + i, name: `ClientDropTest_${i}`, fields: [] })

console.log('Protocol registry seeded')
