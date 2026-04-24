 Layer 1 done. Summary of the pure-refactor slice:                                                                           
                                                                                                                              
  Added src/main/runtimes/ (228 lines across 7 files):                                                                        
  - types.ts — RuntimeAdapter interface + SpawnArgs / ResumeArgs / ComposedPrompt                                             
  - fold.ts — shared inline-system-prompt wrapper for non-Claude runtimes                                                     
  - claude.ts, codex.ts, gemini.ts, opencode.ts — per-runtime adapters                                                        
  - index.ts — getRuntimeAdapter registry                                                                                     
                                                                                                                              
  Modified src/main/terminals.ts:                                                                                             
  - isRecordReachable collapsed to one line (adapter.revalidateSession)
  - buildRuntimeArgs collapsed from 60+ lines of switch to 14 lines of adapter delegation                                     
  - Snapshot/capture block collapsed from four runtime branches × two places to one uniform
  Promise.resolve(adapter.snapshotSessions(cwd)).then(adapter.captureNewSession) path                                         
  - buildSoloInitialPrompt deleted; runZone now calls adapter.composeSystemAndUser — the single seam that will carry the      
  Claude-only → uniform fix in v5                                                                                             
                                                                                                                              
  Verified:                                            
  - npm run build passes clean (main + preload + renderer chunks all build)                                                   
  - tsc --build tsconfig.node.json + tsc --build tsconfig.web.json both exit 0                                                
                                                                                                                              
  Behavior is unchanged — v4 mailbox transport is untouched. When we move to the v5 protocol layers next, every new module    
  will sit behind getRuntimeAdapter() instead of scattering runtime branches.                                                 
                                                                                                                              
  Ready for Layer 2 (activity-JSONL + state + status modules, dormant under v4) whenever you want to proceed.
Layer 2 done, dormant. Summary:                                                                                             
                                                                                                                              
  Added src/main/orchestrator/ (497 lines across 3 files):                                                                    
                                                                                                                              
  - activity.ts — the v5 coordination transport primitive. Defines ActivityEvent (7 kinds: task-received, progress, ask,      
  answer, done, failed, note). Exposes activityLogPath, ensureActivityLog, appendActivity, readAllActivity, tailActivity, and 
  watchActivity. The watcher is narrow per-file fs.watch with a partial-line buffer, offset tracking, truncation recovery, and
   a disposer — replaces v4's O(P×M) full-inbox rescan.                                                                       
  - state.ts — per-participant ephemeral snapshot. ParticipantState tracks                                                    
  role/label/runtime/sessionId/lastTaskStatus/lastActivityTs/ptyAlive/staleEscalations. Atomic mktemp+rename writes via       
  writeState; readState / updateState / initialState for callers. TaskStatus union matches the per-task state machine from the
   plan (pending → dispatched → in-progress → {done | failed | blocked | resumed}).                                           
  - status.ts — pure multi-signal computeParticipantStatus (PTY-dead > ask/failed/done > both-idle-past-threshold >           
  running/starting). Also exposes staleDurationMs and shouldEscalateStale for the scheduler to call when deciding whether to  
  fire a conductor escalation.                                                                                                
                                                                                                                              
  Verified: tsc --build tsconfig.node.json exits 0; npm run build passes clean. No wiring to dispatch yet — these modules are 
  importable but unused. Scheduler/conductor in the next slice will consume them.                                           
                                                                                                                              
  Tree state: one file modified (terminals.ts from Layer 1), two new directories (runtimes/, orchestrator/). Ready for Layer 3
   (prompt rewrite + feature flag) or Layer 4 (scheduler + conductor + dispatch) whenever you want to proceed.
                                                                                                                               
