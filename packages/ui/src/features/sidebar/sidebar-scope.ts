/**
 * Everything `Sidebar` is, minus the markup. The component builds this once and reads it, and the
 * regions read it through the scope context.
 *
 * The body here is composition: each store under `stores/` owns one concern and is built in
 * dependency order, because a store can only be handed what already exists. The drag&drop pipeline
 * is the one part that needs a closure of its own, and `createSidebarDragEngine` is it.
 */

import { createContext, createEffect, onCleanup, useContext } from "solid-js";
import { createScrollFades } from "../../components/createScrollFades";
import { createSidebarDragEngine } from "./createSidebarDragEngine";
import type { SidebarProps } from "./sidebar-types";
import { createSidebarAnnouncementStore } from "./stores/announcement-store";
import { createSidebarDataStore } from "./stores/data-store";
import { createSidebarDragStateStore } from "./stores/drag-state-store";
import { createSidebarLayoutActions } from "./stores/layout-actions";
import { createSidebarPendingStore } from "./stores/pending-store";
import { createSidebarSearchStore } from "./stores/search-store";

const SIDEBAR_SCROLL_POSITIONS = new Map<string, number>();
const MAX_SAVED_SIDEBAR_POSITIONS = 64;

export function createSidebarScope(props: SidebarProps) {
  const layoutMutable = () => props.layoutMutable !== false;
  const scrollFades = createScrollFades();
  let agentList: HTMLElement | undefined;
  let restoreObserver: ResizeObserver | undefined;
  let userScrollUntil = 0;
  let restoreFrame: number | undefined;

  const restoreScrollPosition = () => {
    const key = props.scrollRestorationKey;
    if (!key || !agentList) return;
    const saved = SIDEBAR_SCROLL_POSITIONS.get(key);
    if (saved === undefined || saved <= 0) return;
    const maxScrollTop = Math.max(0, agentList.scrollHeight - agentList.clientHeight);
    if (maxScrollTop + 2 >= saved && Math.abs(agentList.scrollTop - saved) > 2) agentList.scrollTop = saved;
  };

  const scheduleScrollRestore = () => {
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined;
      restoreScrollPosition();
      scrollFades.remeasure();
    });
  };

  const { announce, announceError, reorderAnnouncement } = createSidebarAnnouncementStore();
  const { expandToSearch, normalizedQuery, query, setQuery, setSearchInputElement } = createSidebarSearchStore({
    props,
  });
  // The drag state is built from the data store, so the data store reads it through this reference,
  // which is set once the drag state exists.
  let dragActive = () => false;
  const {
    assignedSectionId,
    chatKind,
    chatName,
    chatPinnedItems,
    customSectionById,
    directThreadByMember,
    filteredAgents,
    filteredChats,
    filteredChatsBySection,
    filteredPeople,
    orderedPeople,
    personById,
    resolvedPinnedItems,
    sectionAcceptsChat,
    sectionIsCollapsed,
    sectionLabel,
    sectionPosition,
    visiblePinnedKeys,
    visibleSectionIds,
    waitingAgents,
  } = createSidebarDataStore({ normalizedQuery, props, dragActive: () => dragActive() });
  const {
    cancelSectionEditor,
    closeDelete,
    confirmDelete,
    confirmClearHistory,
    confirmClearChannelHistory,
    confirmSectionDelete,
    deleteError,
    deleteTargetIsHistory,
    deleteTarget,
    channelDeleteTarget,
    channelHistoryDeleteTarget,
    deleting,
    openDelete,
    openClearHistory,
    openClearChannelHistory,
    pending,
    releaseSectionNameInput,
    saveSectionEditor,
    sectionDeleteTarget,
    setSectionNameInput,
    startCreateSection,
    startRenameSection,
    updateSectionEditorName,
  } = createSidebarPendingStore({ customSectionById, props });
  const dragState = createSidebarDragStateStore({ chatKind, sectionAcceptsChat });
  dragActive = () => dragState.draggingKind() !== undefined;
  const { assignChatSection, commitSidebarDrop, movePersonByKeyboard, movePinnedItem, moveSection } =
    createSidebarLayoutActions({
      announce,
      announceError,
      assignedSectionId,
      canPinDraggedSidebarItem: dragState.canPinDraggedSidebarItem,
      chatName,
      chatPinnedItems,
      draggedSidebarItem: dragState.draggedSidebarItem,
      filteredChatsBySection,
      filteredPeople,
      layoutMutable,
      orderedPeople,
      personById,
      props,
      sectionLabel,
      visiblePinnedKeys,
      visibleSectionIds,
    });
  const {
    dropSidebarNativeDrag,
    endChatDragging,
    handleListDragLeave,
    sidebarClickIsSuppressed,
    startChatDragging,
    startNativeItemDragging,
    startPersonDragging,
    startSectionDragging,
    stopSidebarDragging,
    updateSidebarNativeDrag,
  } = createSidebarDragEngine({
    assignedSectionId,
    canPinDraggedItem: dragState.canPinDraggedSidebarItem,
    chatKind,
    chatPinnedItems,
    commitSidebarDrop,
    dragState,
    filteredChatsBySection,
    filteredPeople,
    getAgentList: () => agentList,
    props,
    scrollFades,
    sectionAcceptsChat,
    visiblePinnedKeys,
    visibleSectionIds,
  });

  onCleanup(() => {
    stopSidebarDragging();
    scrollFades.stop();
    restoreObserver?.disconnect();
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
  });

  createEffect(
    () => [resolvedPinnedItems(), waitingAgents(), filteredChats(), filteredPeople()],
    () => {
      scrollFades.remeasure();
      scheduleScrollRestore();
    },
  );

  createEffect(
    () => props.scrollRestorationKey,
    (key) => {
      if (key) scheduleScrollRestore();
    },
  );

  const noteAgentListScrollInput = () => {
    userScrollUntil = performance.now() + 1_500;
  };

  const onAgentListScroll = () => {
    scrollFades.measure();
    const key = props.scrollRestorationKey;
    if (!key || !agentList) return;
    const previous = SIDEBAR_SCROLL_POSITIONS.get(key) ?? 0;
    const maxScrollTop = Math.max(0, agentList.scrollHeight - agentList.clientHeight);
    // A list refresh can temporarily make the old offset unreachable and the browser clamps it to
    // zero. Keep the saved offset until content returns. Explicit scrolling always replaces it.
    if (performance.now() <= userScrollUntil || maxScrollTop + 2 >= previous) {
      const positions: Map<string, number> = SIDEBAR_SCROLL_POSITIONS;
      positions.delete(key);
      positions.set(key, agentList.scrollTop);
      while (positions.size > MAX_SAVED_SIDEBAR_POSITIONS) {
        const oldestKey = positions.keys().next().value;
        if (oldestKey === undefined) break;
        positions.delete(oldestKey);
      }
    }
  };

  const setAgentListContentElement = (element: HTMLElement) => {
    restoreObserver?.disconnect();
    restoreObserver = new ResizeObserver(scheduleScrollRestore);
    restoreObserver.observe(element);
    scheduleScrollRestore();
  };

  /** The two statements the list's `ref` used to run inline, in the same order. */
  const setAgentListElement = (element: HTMLElement) => {
    agentList = element;
    scrollFades.bind(element);
    scheduleScrollRestore();
  };

  /**
   * The scope's public surface, and the whole of what a region component may reach for. The drag
   * store's writers are deliberately absent: only the engine may move a drag along.
   */
  return {
    assignChatSection,
    cancelSectionEditor,
    closeDelete,
    confirmDelete,
    confirmClearHistory,
    confirmClearChannelHistory,
    confirmSectionDelete,
    customSectionById,
    deleteError,
    deleteTargetIsHistory,
    deleteTarget,
    channelDeleteTarget,
    channelHistoryDeleteTarget,
    deleting,
    chatPinnedItems,
    directThreadByMember,
    dragOffset: dragState.dragOffset,
    dragOverPinnedKey: dragState.dragOverPinnedKey,
    draggedChatId: dragState.draggedChatId,
    draggedPinnedKey: dragState.draggedPinnedKey,
    draggingKind: dragState.draggingKind,
    dropSidebarNativeDrag,
    emptyPinnedDropVisible: dragState.emptyPinnedDropVisible,
    endChatDragging,
    expandToSearch,
    filteredAgents,
    filteredChats,
    filteredChatsBySection,
    filteredPeople,
    handleListDragLeave,
    layoutMutable,
    movePersonByKeyboard,
    movePinnedItem,
    moveSection,
    normalizedQuery,
    openDelete,
    openClearHistory,
    openClearChannelHistory,
    pending,
    pinnedDropActive: dragState.pinnedDropActive,
    props,
    query,
    releaseSectionNameInput,
    reorderAnnouncement,
    resolvedPinnedItems,
    saveSectionEditor,
    scrollFades,
    noteAgentListScrollInput,
    onAgentListScroll,
    sectionDeleteTarget,
    sectionDragClasses: dragState.sectionDragClasses,
    sectionIsCollapsed,
    sectionPosition,
    setAgentListElement,
    setAgentListContentElement,
    setQuery,
    setSearchInputElement,
    setSectionNameInput,
    sidebarClickIsSuppressed,
    startChatDragging,
    startCreateSection,
    startNativeItemDragging,
    startPersonDragging,
    startRenameSection,
    startSectionDragging,
    stopSidebarDragging,
    updateSectionEditorName,
    updateSidebarNativeDrag,
    visibleSectionIds,
    waitingAgents,
  };
}

export type SidebarScope = ReturnType<typeof createSidebarScope>;

export const SidebarScopeContext = createContext<SidebarScope>();

export function useSidebarScope(): SidebarScope {
  const scope = useContext(SidebarScopeContext);
  if (!scope) throw new Error("Sidebar scope is unavailable outside Sidebar.");
  return scope;
}
