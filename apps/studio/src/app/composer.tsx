import {
  Bot,
  Check,
  ChevronDown,
  Files,
  FolderOpen,
  GitBranch,
  ImagePlus,
  Plus,
  SendHorizontal,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import type {
  ClipboardEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  RefObject,
} from 'react';

import { ApprovalPanel, type useApprovals } from '../features/approvals/approval-panel.js';
import type { ApprovalRequest } from '../features/approvals/approval-api.js';
import { ExecutionQueueList } from '../features/agent/execution-queue-list.js';
import type { useExecutionQueues } from '../features/agent/use-execution-queues.js';
import {
  CommandPickerList,
  commandOptionId,
  commandPickerListId,
} from '../features/commands/command-picker-list.js';
import type { useCommandPicker } from '../features/commands/use-command-picker.js';
import type { useComposerDraft } from '../features/composer/use-composer-draft.js';
import { ConnectedContextMeter } from '../features/conversation/connected-conversation-panels.js';
import type { createConversationStore } from '../features/conversation/conversation-store.js';
import {
  DraftContextAttachments,
  DraftFileAttachments,
} from '../features/file-context/file-attachments.js';
import { FilePicker } from '../features/file-context/file-picker.js';
import type { useFilePicker } from '../features/file-context/use-file-picker.js';
import type { ProviderDescriptor } from '../features/providers/provider-types.js';
import { SkillPicker } from '../features/skills/skill-picker.js';
import { sameSkill } from '../features/skills/skill-types.js';
import type { useSessionSkills } from '../features/skills/use-session-skills.js';
import type { AgentTaskView } from '../features/tasks/task-types.js';
import type { useAgentTasks } from '../features/tasks/use-agent-tasks.js';
import { permissionOptions, reasoningEffortOptions } from './app-constants.js';
import type {
  OpenMenu,
  PendingImage,
  RunStatus,
  SessionRunState,
  StudioProject,
} from './app-types.js';
import type { PermissionMode } from './composer-preferences.js';
import type { useComposerAttachments } from './use-composer-attachments.js';
import type { useProviderSettings } from './use-provider-settings.js';

type ComposerAttachments = ReturnType<typeof useComposerAttachments>;

export type ComposerProps = {
  // Session and run
  readonly activeProject: StudioProject | undefined;
  readonly activeProjectId: string;
  readonly activeSessionId: string;
  readonly activeTaskRoot: string;
  readonly isChildSession: boolean;
  readonly canCompose: boolean;
  readonly status: RunStatus;
  readonly activeRunState: SessionRunState;
  readonly admitting: Record<string, boolean>;
  readonly activeQueue: ReturnType<typeof useExecutionQueues>['states'][string] | undefined;
  readonly queueController: ReturnType<typeof useExecutionQueues>;
  readonly conversationStore: ReturnType<typeof createConversationStore>;
  readonly taskState: Pick<ReturnType<typeof useAgentTasks>, 'tasks' | 'error'>;
  // Approvals
  readonly approvals: Pick<ReturnType<typeof useApprovals>, 'pending' | 'decide'>;
  readonly taskForApproval: (approval: ApprovalRequest) => AgentTaskView | undefined;
  readonly inspectApproval: (approval: ApprovalRequest) => void;
  // Draft and pickers
  readonly composerDraft: ReturnType<typeof useComposerDraft>;
  readonly messageInput: string;
  readonly setMessageInput: (text: string) => void;
  readonly pendingImages: readonly PendingImage[];
  readonly commandPicker: ReturnType<typeof useCommandPicker>;
  readonly filePicker: ReturnType<typeof useFilePicker>;
  readonly sessionSkills: ReturnType<typeof useSessionSkills>;
  readonly messageInputRef: RefObject<HTMLTextAreaElement | null>;
  readonly imageInputRef: RefObject<HTMLInputElement | null>;
  readonly composerIsComposing: { current: boolean };
  // Attachments
  readonly viewerFilePath: ComposerAttachments['viewerFilePath'];
  readonly gitChangesAvailability: ComposerAttachments['gitChangesAvailability'];
  readonly addComposerContext: ComposerAttachments['addComposerContext'];
  readonly addViewerFileContext: ComposerAttachments['addViewerFileContext'];
  readonly addImageFiles: ComposerAttachments['addImageFiles'];
  readonly removePendingImage: ComposerAttachments['removePendingImage'];
  readonly handleComposerPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  // Model and permission
  readonly providerSettings: ReturnType<typeof useProviderSettings>['providerSettings'];
  readonly selectedProvider: ProviderDescriptor | undefined;
  readonly selectedProviderId: string;
  readonly selectedModel: string;
  readonly reasoningEffort: string;
  readonly setReasoningEffort: (value: string) => void;
  readonly chooseProvider: (provider: ProviderDescriptor) => void;
  readonly permissionMode: PermissionMode;
  readonly setPermissionMode: (mode: PermissionMode) => void;
  // Menus and actions
  readonly openMenu: OpenMenu;
  readonly setOpenMenu: (menu: OpenMenu) => void;
  readonly toggleMenu: (menu: Exclude<OpenMenu, null>) => void;
  readonly setIsActivityPanelOpen: (open: boolean) => void;
  readonly handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly handleMessageKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  readonly cancelRun: () => void;
  readonly copyQueuedMessage: (executionId: string) => Promise<void>;
};

/** The message form: queue, approvals, text box, attachments, tools and send. */
export function Composer({
  activeProject,
  activeProjectId,
  activeSessionId,
  activeTaskRoot,
  isChildSession,
  canCompose,
  status,
  activeRunState,
  admitting,
  activeQueue,
  queueController,
  conversationStore,
  taskState,
  approvals,
  taskForApproval,
  inspectApproval,
  composerDraft,
  messageInput,
  setMessageInput,
  pendingImages,
  commandPicker,
  filePicker,
  sessionSkills,
  messageInputRef,
  imageInputRef,
  composerIsComposing,
  viewerFilePath,
  gitChangesAvailability,
  addComposerContext,
  addViewerFileContext,
  addImageFiles,
  removePendingImage,
  handleComposerPaste,
  providerSettings,
  selectedProvider,
  selectedProviderId,
  selectedModel,
  reasoningEffort,
  setReasoningEffort,
  chooseProvider,
  permissionMode,
  setPermissionMode,
  openMenu,
  setOpenMenu,
  toggleMenu,
  setIsActivityPanelOpen,
  handleSubmit,
  handleMessageKeyDown,
  cancelRun,
  copyQueuedMessage,
}: ComposerProps): ReactElement {
  return (
    <form className="composer" onSubmit={handleSubmit}>
      {canCompose && activeQueue !== undefined ? (
        <ExecutionQueueList
          state={activeQueue}
          pending={queueController.pending[activeSessionId] ?? false}
          onCancel={(id) => void queueController.cancel(activeSessionId, id)}
          onMove={(id) => void queueController.move(activeSessionId, id)}
          onCopy={(id) => void copyQueuedMessage(id)}
        />
      ) : null}
      <ApprovalPanel
        pending={approvals.pending.filter(
          (approval) =>
            approval.sessionId === activeSessionId ||
            (canCompose && approval.sessionId === undefined) ||
            (activeTaskRoot === activeSessionId && taskForApproval(approval) !== undefined),
        )}
        onDecide={approvals.decide}
        onInspectApproval={inspectApproval}
        taskTitleForApproval={(approval) => taskForApproval(approval)?.title}
      />
      {!canCompose ? (
        <p className="composer-readonly-note" role="status">
          {isChildSession ? '子会话只读。返回父会话继续发送。' : '正在读取会话详情…'}
          {isChildSession && taskState.error !== undefined ? ` ${taskState.error}` : ''}
        </p>
      ) : (
        <div className="composer-box">
          {sessionSkills.open && !commandPicker.open && activeSessionId !== '' ? (
            <SkillPicker
              key={`${activeSessionId}:${activeProject?.folderPath ?? ''}`}
              sessionId={activeSessionId}
              catalog={sessionSkills.catalogState.catalog}
              loading={sessionSkills.catalogState.loading}
              error={sessionSkills.catalogState.error}
              selected={sessionSkills.draft.selected}
              onToggle={sessionSkills.toggle}
              onRefresh={() => void sessionSkills.refresh()}
              onClose={sessionSkills.close}
            />
          ) : null}
          <FilePicker picker={filePicker} />
          {commandPicker.open ? (
            <CommandPickerList
              commands={commandPicker.items}
              activeIndex={commandPicker.activeIndex}
              onSelect={commandPicker.select}
              onHover={commandPicker.setActiveIndex}
            />
          ) : null}
          <label className="sr-only" htmlFor="message-input">
            发送消息
          </label>
          <textarea
            id="message-input"
            name="message"
            rows={2}
            ref={messageInputRef}
            value={messageInput}
            onChange={(event) => {
              setMessageInput(event.target.value);
              if (!composerIsComposing.current && !(event.nativeEvent as InputEvent).isComposing)
                filePicker.updateSelection(
                  event.target.value,
                  event.target.selectionStart,
                  event.target.selectionEnd,
                );
            }}
            onSelect={(event) =>
              !composerIsComposing.current &&
              filePicker.updateSelection(
                event.currentTarget.value,
                event.currentTarget.selectionStart,
                event.currentTarget.selectionEnd,
              )
            }
            onCompositionStart={() => {
              composerIsComposing.current = true;
              filePicker.close();
            }}
            onCompositionEnd={(event) => {
              composerIsComposing.current = false;
              filePicker.updateSelection(
                event.currentTarget.value,
                event.currentTarget.selectionStart,
                event.currentTarget.selectionEnd,
              );
            }}
            onKeyDown={handleMessageKeyDown}
            onPaste={handleComposerPaste}
            placeholder="给 Agent 分配一个任务…"
            {...(filePicker.open && !filePicker.buttonMode
              ? {
                  'aria-controls': filePicker.listId,
                  ...(filePicker.items.length === 0
                    ? {}
                    : { 'aria-activedescendant': filePicker.optionId(filePicker.activeIndex) }),
                }
              : {})}
            {...(commandPicker.open
              ? {
                  'aria-controls': commandPickerListId,
                  'aria-activedescendant': commandOptionId(
                    commandPicker.items[commandPicker.activeIndex]?.name ?? '',
                  ),
                }
              : {})}
          />
          {composerDraft.draft.literalSend ? (
            <p className="composer-prepared-status" role="status">
              已准备文本，请检查并点击发送
            </p>
          ) : null}
          <DraftFileAttachments
            files={composerDraft.draft.files}
            onRemove={composerDraft.removeFile}
          />
          <DraftContextAttachments
            contexts={composerDraft.draft.contexts}
            onRemove={composerDraft.removeContext}
          />
          {pendingImages.length > 0 ? (
            <div className="composer-attachments" aria-label="待发送图片">
              {pendingImages.map((image) => (
                <span className="composer-attachment" key={image.id}>
                  <img
                    className="composer-attachment-thumb"
                    src={`data:${image.mediaType};base64,${image.data}`}
                    alt={image.name}
                  />
                  <button
                    type="button"
                    aria-label={`移除图片 ${image.name}`}
                    onClick={() => removePendingImage(image.id)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {sessionSkills.draft.selected.length > 0 ? (
            <div className="skill-chips" aria-label="待发送技能">
              {sessionSkills.draft.selected.map((skill) => {
                const latest = sessionSkills.catalogState.catalog?.entries.find(
                  (entry) => entry.id === skill.id,
                );
                const stale =
                  latest !== undefined
                    ? !sameSkill(latest, skill)
                    : sessionSkills.catalogState.catalog?.complete === true;
                return (
                  <span
                    className={`skill-chip${stale ? ' skill-warning' : ''}`}
                    key={skill.id}
                    title={`${skill.source.label} · ${skill.id}`}
                  >
                    <span>
                      {skill.name}
                      {stale ? ' · 内容已变化，请重新选择' : ''}
                    </span>
                    <button
                      type="button"
                      aria-label={`移除技能 ${skill.name}`}
                      onClick={() => sessionSkills.remove(skill.id)}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          ) : null}
          <div className="composer-toolbar">
            <div className="composer-tools">
              <div className={`menu-anchor${openMenu === 'context' ? ' menu-anchor-open' : ''}`}>
                <button
                  className="composer-tool-button"
                  type="button"
                  aria-label="添加内容"
                  title="添加图片、项目文件、上下文或技能"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === 'context'}
                  onClick={() => toggleMenu('context')}
                >
                  <Plus aria-hidden="true" />
                </button>
                {openMenu === 'context' ? (
                  <div
                    className="popup-menu popup-menu-composer composer-add-menu"
                    role="menu"
                    aria-label="添加内容"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      aria-label="添加图片"
                      onClick={() => {
                        setOpenMenu(null);
                        imageInputRef.current?.click();
                      }}
                    >
                      <span className="menu-icon">
                        <ImagePlus aria-hidden="true" />
                      </span>
                      添加图片
                      <small className="menu-hint" aria-hidden="true">
                        也可粘贴
                      </small>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      aria-label="添加项目文件"
                      onClick={() => {
                        setOpenMenu(null);
                        commandPicker.close();
                        sessionSkills.close();
                        filePicker.openFromButton();
                      }}
                    >
                      <span className="menu-icon">
                        <Files aria-hidden="true" />
                      </span>
                      添加项目文件
                      <small className="menu-hint" aria-hidden="true">
                        输入 @
                      </small>
                    </button>
                    <div className="menu-divider" role="separator" />
                    <div role="group" aria-label="上下文">
                      <p className="menu-section-label" aria-hidden="true">
                        上下文
                      </p>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={
                          viewerFilePath === null ||
                          composerDraft.draft.files.length >= 8 ||
                          composerDraft.draft.files.some((file) => file.path === viewerFilePath)
                        }
                        title={viewerFilePath ?? '先在文件面板打开文件'}
                        onClick={addViewerFileContext}
                      >
                        <span className="menu-icon">
                          <Files aria-hidden="true" />
                        </span>
                        当前文件
                        {viewerFilePath !== null &&
                        composerDraft.draft.files.some((file) => file.path === viewerFilePath) ? (
                          <Check className="menu-check" aria-hidden="true" />
                        ) : null}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={
                          gitChangesAvailability?.projectId !== activeProjectId ||
                          gitChangesAvailability.state !== 'available' ||
                          composerDraft.draft.contexts.some(({ kind }) => kind === 'git-changes')
                        }
                        title={
                          gitChangesAvailability?.projectId === activeProjectId &&
                          gitChangesAvailability.state === 'unavailable'
                            ? '项目不是 Git 仓库，或还没有任何提交'
                            : gitChangesAvailability?.projectId === activeProjectId &&
                                gitChangesAvailability.state === 'unknown'
                              ? '无法检查 Git 状态'
                              : undefined
                        }
                        onClick={() => addComposerContext('git-changes')}
                      >
                        <span className="menu-icon">
                          <GitBranch aria-hidden="true" />
                        </span>
                        Git 变更
                        {composerDraft.draft.contexts.some(({ kind }) => kind === 'git-changes') ? (
                          <Check className="menu-check" aria-hidden="true" />
                        ) : gitChangesAvailability?.projectId === activeProjectId &&
                          gitChangesAvailability.state === 'unavailable' ? (
                          <small className="menu-hint">需要有提交的 Git 仓库</small>
                        ) : gitChangesAvailability?.projectId === activeProjectId &&
                          gitChangesAvailability.state === 'unknown' ? (
                          <small className="menu-hint">无法检查 Git 状态</small>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={
                          activeProjectId === '' ||
                          composerDraft.draft.contexts.some(({ kind }) => kind === 'project-tree')
                        }
                        onClick={() => addComposerContext('project-tree')}
                      >
                        <span className="menu-icon">
                          <FolderOpen aria-hidden="true" />
                        </span>
                        项目目录
                        {composerDraft.draft.contexts.some(
                          ({ kind }) => kind === 'project-tree',
                        ) ? (
                          <Check className="menu-check" aria-hidden="true" />
                        ) : null}
                      </button>
                    </div>
                    <div className="menu-divider" role="separator" />
                    <button
                      type="button"
                      role="menuitem"
                      aria-label="选择技能"
                      disabled={activeSessionId === ''}
                      title={activeSessionId === '' ? '请先新建会话以选择技能' : '为本轮选择技能'}
                      onClick={() => {
                        setOpenMenu(null);
                        filePicker.close();
                        commandPicker.close();
                        sessionSkills.show();
                      }}
                    >
                      <span className="menu-icon">
                        <Sparkles aria-hidden="true" />
                      </span>
                      选择技能
                      {activeSessionId === '' ? (
                        <small className="menu-hint" aria-hidden="true">
                          请先新建会话
                        </small>
                      ) : null}
                    </button>
                  </div>
                ) : null}
              </div>
              <div className={`menu-anchor${openMenu === 'permission' ? ' menu-anchor-open' : ''}`}>
                <button
                  className="permission-button"
                  type="button"
                  aria-expanded={openMenu === 'permission'}
                  onClick={() => toggleMenu('permission')}
                >
                  {permissionOptions.find((option) => option.value === permissionMode)?.label ??
                    '常规'}
                  <ChevronDown aria-hidden="true" />
                </button>
                {openMenu === 'permission' ? (
                  <div className="popup-menu popup-menu-composer" role="menu" aria-label="权限模式">
                    {permissionOptions.map((option) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={option.value}
                        className={option.danger === true ? 'permission-option-danger' : undefined}
                        onClick={() => {
                          setPermissionMode(option.value);
                          setOpenMenu(null);
                        }}
                      >
                        <span className="menu-icon">
                          <option.icon aria-hidden="true" />
                        </span>
                        <span className="provider-menu-copy">
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </span>
                        {permissionMode === option.value ? (
                          <Check className="menu-check" aria-hidden="true" />
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <input
                className="sr-only"
                ref={imageInputRef}
                type="file"
                accept="image/*"
                aria-label="选择图片文件"
                multiple
                onChange={(event) => {
                  void addImageFiles(event.target.files);
                  event.target.value = '';
                }}
              />
            </div>
            <div className="composer-controls">
              <ConnectedContextMeter
                store={conversationStore}
                sessionId={activeSessionId}
                onOpen={() => setIsActivityPanelOpen(true)}
              />
              <div className={`menu-anchor${openMenu === 'model' ? ' menu-anchor-open' : ''}`}>
                <button
                  className="model-button"
                  type="button"
                  aria-expanded={openMenu === 'model'}
                  aria-label="模型与强度"
                  onClick={() => toggleMenu('model')}
                >
                  <span className="model-button-label">
                    {selectedProvider?.label ?? selectedModel}
                  </span>
                  <span className="model-button-strength">
                    ·{' '}
                    {reasoningEffortOptions.find((option) => option.value === reasoningEffort)
                      ?.label ?? '默认'}
                  </span>
                  <ChevronDown aria-hidden="true" />
                </button>
                {openMenu === 'model' ? (
                  <div
                    className="popup-menu popup-menu-composer popup-menu-right"
                    role="menu"
                    aria-label="选择模型"
                  >
                    {providerSettings.providers.map((provider) => (
                      <button
                        type="button"
                        role="menuitem"
                        aria-label={provider.label}
                        key={provider.id}
                        onClick={() => chooseProvider(provider)}
                      >
                        <span className="menu-icon">
                          <Bot aria-hidden="true" />
                        </span>
                        <span className="provider-menu-copy">
                          <strong>{provider.label}</strong>
                          {provider.defaultModel !== undefined ? (
                            <small>{provider.defaultModel}</small>
                          ) : null}
                        </span>
                        {selectedProviderId === provider.id ? (
                          <Check className="menu-check" aria-hidden="true" />
                        ) : null}
                      </button>
                    ))}
                    <div className="menu-divider" />
                    <div className="model-strength" role="group" aria-label="模型强度">
                      <div className="model-strength-head">
                        <span>强度</span>
                        <small>
                          {reasoningEffortOptions.find((option) => option.value === reasoningEffort)
                            ?.label ?? '默认'}
                        </small>
                      </div>
                      <input
                        type="range"
                        className="model-strength-slider"
                        min={0}
                        max={reasoningEffortOptions.length - 1}
                        step={1}
                        value={Math.max(
                          0,
                          reasoningEffortOptions.findIndex(
                            (option) => option.value === reasoningEffort,
                          ),
                        )}
                        aria-label="模型强度"
                        onChange={(event) =>
                          setReasoningEffort(
                            reasoningEffortOptions[Number(event.target.value)]?.value ?? 'medium',
                          )
                        }
                      />
                      <div className="model-strength-scale" aria-hidden="true">
                        <span>更快</span>
                        <span>更聪明</span>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
              {status === 'streaming' ? (
                <span className="execution-connection-status" role="status">
                  {activeRunState.stopping
                    ? '正在停止…'
                    : activeRunState.connection === 'reconnecting'
                      ? '连接已断开，正在重连…'
                      : activeRunState.connection === 'connecting'
                        ? '正在连接…'
                        : '运行中'}
                </span>
              ) : null}
              {status === 'streaming' ? (
                <button
                  className="send-button send-button-cancel"
                  type="button"
                  onClick={cancelRun}
                  aria-label="停止本轮及派生任务"
                  title="停止本轮及派生任务"
                >
                  <Square aria-hidden="true" />
                </button>
              ) : null}
              <button
                className="send-button"
                type="submit"
                disabled={
                  admitting[activeSessionId] ||
                  (messageInput.trim() === '' &&
                    pendingImages.length === 0 &&
                    composerDraft.draft.files.length === 0)
                }
                aria-label={
                  status === 'streaming' || (activeQueue?.queued.length ?? 0) > 0
                    ? '加入队列'
                    : '发送'
                }
              >
                <SendHorizontal aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
