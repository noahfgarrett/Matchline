import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { JSX, ReactNode } from 'react';

/**
 * A reorderable vertical list.
 *
 * Two things this wrapper insists on, because both are correctness rather than
 * polish:
 *
 * - **The drag handle is its own control.** A row full of selects and text
 *   inputs cannot also be the drag surface; a pointer-down on a `<select>`
 *   would start a drag instead of opening it. Only the handle carries the
 *   drag listeners.
 * - **Keyboard reordering works.** `KeyboardSensor` with the sortable
 *   coordinate getter makes the handle focusable and the list reorderable with
 *   the arrow keys, which is the only way a level stack is editable without a
 *   mouse.
 *
 * An 8px activation distance stops a click on the handle registering as a
 * zero-length drag, which would otherwise fire a reorder to the same position
 * and round-trip a pointless write to main.
 */

export interface SortableListProps<TItem> {
  readonly items: readonly TItem[];
  readonly keyOf: (item: TItem) => string;
  readonly renderItem: (item: TItem, index: number, handle: ReactNode) => ReactNode;
  readonly onReorder: (items: readonly TItem[]) => void;
  readonly ariaLabel: string;
  readonly testId?: string;
}

export function SortableList<TItem>({
  items,
  keyOf,
  renderItem,
  onReorder,
  ariaLabel,
  testId,
}: SortableListProps<TItem>): JSX.Element {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ids = items.map(keyOf);

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (over === null || active.id === over.id) {
      return;
    }
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) {
      return;
    }
    onReorder(arrayMove([...items], from, to));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol className="sortable" aria-label={ariaLabel} data-testid={testId}>
          {items.map((item: TItem, index: number): JSX.Element => (
            <SortableRow key={keyOf(item)} id={keyOf(item)}>
              {(handle: ReactNode): ReactNode => renderItem(item, index, handle)}
            </SortableRow>
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({
  id,
  children,
}: {
  readonly id: string;
  readonly children: (handle: ReactNode) => ReactNode;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  const handle = (
    <button
      type="button"
      className="sortable__handle"
      aria-label="Reorder"
      data-testid={`drag-${id}`}
      {...attributes}
      {...listeners}
    >
      ⠿
    </button>
  );

  return (
    <li
      ref={setNodeRef}
      className={`sortable__item${isDragging ? ' sortable__item--dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition: transition ?? undefined }}
    >
      {children(handle)}
    </li>
  );
}
