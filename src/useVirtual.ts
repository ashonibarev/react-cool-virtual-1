import { useCallback, useRef, useState } from "react";

import {
  Align,
  Item,
  ItemSize,
  Measure,
  Options,
  Return,
  ScrollTo,
  ScrollToOptions,
  ScrollToItem,
  ScrollToItemOptions,
  SsrItemCount,
} from "./types";
import {
  easeInOutCubic,
  findNearestBinarySearch,
  isNumber,
  now,
  shouldUpdate,
  useDebounce,
  useIsoLayoutEffect,
  useLatest,
  useResizeEffect,
} from "./utils";

const DEFAULT_ITEM_SIZE = 50;
const DEBOUNCE_INTERVAL = 150;

const getInitItems = (itemSize: ItemSize, ssrItemCount?: SsrItemCount) => {
  if (!ssrItemCount) return [];

  const [idx, len] = isNumber(ssrItemCount)
    ? [0, ssrItemCount - 1]
    : ssrItemCount;
  const ssrItems = [];

  for (let i = idx; i <= len; i += 1)
    ssrItems[i] = {
      index: i,
      start: 0,
      width: 0,
      size: isNumber(itemSize) ? itemSize : itemSize(i, 0) ?? DEFAULT_ITEM_SIZE,
      measureRef: () => null,
    };

  return ssrItems;
};

export default <
  O extends HTMLElement = HTMLElement,
  I extends HTMLElement = HTMLElement
>({
  itemCount,
  ssrItemCount,
  itemSize = DEFAULT_ITEM_SIZE,
  horizontal,
  overscanCount = 1,
  useIsScrolling,
  stickyIndices,
  scrollDuration = 500,
  scrollEasingFunction = easeInOutCubic,
  loadMoreCount = 15,
  isItemLoaded,
  loadMore,
  onScroll,
  onResize,
}: Options): Return<O, I> => {
  const [items, setItems] = useState<Item[]>(() =>
    getInitItems(itemSize, ssrItemCount)
  );
  const isMountedRef = useRef(false);
  const hasDynamicSizeRef = useRef(false);
  const rosRef = useRef<Map<Element, ResizeObserver>>(new Map());
  const scrollOffsetRef = useRef(0);
  const prevItemIdxRef = useRef(-1);
  const prevVStopRef = useRef<number>();
  const outerRef = useRef<O>(null);
  const innerRef = useRef<I>(null);
  const outerRectRef = useRef({ width: 0, height: 0 });
  const msDataRef = useRef<Measure[]>([]);
  const userScrollRef = useRef(true);
  const scrollToRafRef = useRef<number>();
  const stickyIndicesRef = useRef(stickyIndices);
  const isItemLoadedRef = useRef(isItemLoaded);
  const loadMoreRef = useLatest(loadMore);
  const easingFnRef = useLatest(scrollEasingFunction);
  const itemSizeRef = useLatest(itemSize);
  const useIsScrollingRef = useLatest(useIsScrolling);
  const onScrollRef = useLatest(onScroll);
  const onResizeRef = useLatest(onResize);
  const sizeKey = !horizontal ? "height" : "width";
  const marginKey = !horizontal ? "marginTop" : "marginLeft";
  const scrollKey = !horizontal ? "scrollTop" : "scrollLeft";

  const getItemSize = useCallback(
    (idx: number) => {
      const { current: size } = itemSizeRef;
      return isNumber(size)
        ? size
        : size(idx, outerRectRef.current.width) ?? DEFAULT_ITEM_SIZE;
    },
    [itemSizeRef]
  );

  const getMeasure = useCallback((idx: number, size: number): Measure => {
    const start = msDataRef.current[idx - 1]?.end ?? 0;
    return { idx, start, end: start + size, size };
  }, []);

  const measureItems = useCallback(
    (useCache = true) => {
      msDataRef.current.length = itemCount;

      for (let i = 0; i < itemCount; i += 1)
        msDataRef.current[i] = getMeasure(
          i,
          useCache && msDataRef.current[i]
            ? msDataRef.current[i].size
            : getItemSize(i)
        );
    },
    [getItemSize, getMeasure, itemCount]
  );

  const getCalcData = useCallback(
    (scrollOffset: number) => {
      const { current: msData } = msDataRef;
      let vStart = 0;

      if (hasDynamicSizeRef.current) {
        while (
          vStart < msData.length &&
          // To prevent items from jumping while backward scrolling in dynamic size
          msData[vStart].start < (msData[vStart + 1]?.start ?? 0) &&
          msData[vStart].start + msData[vStart].size < scrollOffset
        )
          vStart += 1;
      } else {
        vStart = findNearestBinarySearch(
          0,
          msData.length - 1,
          scrollOffset,
          (idx) => msData[idx].start
        );
      }

      let vStop = vStart;
      let currStart = msData[vStop].start;

      while (
        vStop < msData.length &&
        currStart < scrollOffset + outerRectRef.current[sizeKey]
      ) {
        currStart += msData[vStop].size;
        vStop += 1;
      }

      const oStart = Math.max(vStart - overscanCount, 0);
      const oStop = Math.min(vStop + overscanCount, msData.length) - 1;
      const margin = msData[oStart].start;
      const totalSize = Math[oStop < msData.length - 1 ? "max" : "min"](
        msData[oStop].end + msData[oStop].size,
        msData[msData.length - 1].end
      );

      return {
        oStart,
        oStop,
        vStart,
        vStop: vStop - 1,
        margin,
        innerSize: totalSize - margin,
      };
    },
    [overscanCount, sizeKey]
  );

  const scrollTo = useCallback(
    (offset: number) => {
      if (outerRef.current) outerRef.current[scrollKey] = offset;
    },
    [scrollKey]
  );

  const scrollToOffset = useCallback<ScrollTo>(
    (val, cb) => {
      const { current: prevOffset } = scrollOffsetRef;
      const { offset, smooth }: ScrollToOptions = isNumber(val)
        ? { offset: val }
        : val;

      if (!isNumber(offset)) return;

      userScrollRef.current = false;

      if (!smooth) {
        scrollTo(offset);
        if (cb) cb();

        return;
      }

      const start = now();
      const scroll = () => {
        const time = Math.min((now() - start) / scrollDuration, 1);
        const easing = easingFnRef.current(time);

        scrollTo(easing * (offset - prevOffset) + prevOffset);

        if (time < 1) {
          scrollToRafRef.current = requestAnimationFrame(scroll);
        } else if (cb) {
          cb();
        }
      };

      scrollToRafRef.current = requestAnimationFrame(scroll);
    },
    [easingFnRef, scrollDuration, scrollTo]
  );

  const scrollToItem = useCallback<ScrollToItem>(
    (val, cb) => {
      const {
        index,
        align = Align.auto,
        smooth,
      }: ScrollToItemOptions = isNumber(val) ? { index: val } : val;

      if (!isNumber(index)) return;

      if (hasDynamicSizeRef.current) measureItems();

      const { current: msData } = msDataRef;
      const ms = msData[Math.max(0, Math.min(index, msData.length - 1))];

      if (!ms) return;

      const { start, end, size } = ms;
      let { current: scrollOffset } = scrollOffsetRef;
      const totalSize = msData[msData.length - 1].end;
      const outerSize = outerRectRef.current[sizeKey];

      if (totalSize <= outerSize) {
        if (cb) cb();
        return;
      }

      const endPos = start - outerSize + size;

      switch (align) {
        case Align.start:
          scrollOffset =
            totalSize - start <= outerSize ? totalSize - outerSize : start;
          break;
        case Align.center: {
          const to = start - outerSize / 2 + size / 2;
          scrollOffset =
            totalSize - to <= outerSize ? totalSize - outerSize : to;
          break;
        }
        case Align.end:
          scrollOffset = start + size <= outerSize ? 0 : endPos;
          break;
        default:
          if (scrollOffset > start) {
            scrollOffset = start;
          } else if (scrollOffset + outerSize < end) {
            scrollOffset = endPos;
          }
      }

      if (
        hasDynamicSizeRef.current &&
        Math.abs(scrollOffset - scrollOffsetRef.current) <= 1
      ) {
        if (cb) cb();
        return;
      }

      scrollToOffset({ offset: scrollOffset, smooth }, () => {
        if (!hasDynamicSizeRef.current) {
          if (cb) cb();
        } else {
          setTimeout(() => scrollToItem(val, cb));
        }
      });
    },
    [measureItems, scrollToOffset, sizeKey]
  );

  const [resetIsScrolling, cancelResetIsScrolling] = useDebounce(
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    () => handleScroll(scrollOffsetRef.current),
    DEBOUNCE_INTERVAL
  );

  const [resetUserScroll, cancelResetUserScroll] = useDebounce(() => {
    userScrollRef.current = true;
  }, DEBOUNCE_INTERVAL);

  const handleScroll = useCallback(
    (scrollOffset: number, isScrolling?: boolean, uxScrolling?: boolean) => {
      if (!innerRef.current) return;

      if (
        loadMoreRef.current &&
        !isMountedRef.current &&
        !(isItemLoadedRef.current && isItemLoadedRef.current(0))
      )
        loadMoreRef.current({
          startIndex: 0,
          stopIndex: loadMoreCount - 1,
          loadIndex: 0,
          scrollOffset,
          userScroll: userScrollRef.current,
        });

      if (!itemCount) {
        setItems([]);
        return;
      }

      const { oStart, oStop, vStart, vStop, margin, innerSize } =
        getCalcData(scrollOffset);

      innerRef.current.style[marginKey] = `${margin}px`;
      innerRef.current.style[sizeKey] = `${innerSize}px`;

      const nextItems: Item[] = [];
      const stickies = Array.isArray(stickyIndicesRef.current)
        ? stickyIndicesRef.current
        : [];

      for (let i = oStart; i <= oStop; i += 1) {
        const { current: msData } = msDataRef;
        const { start, size } = msData[i];

        nextItems.push({
          index: i,
          start: start - margin,
          size,
          width: outerRectRef.current.width,
          isScrolling: uxScrolling || undefined,
          isSticky: stickies.includes(i) || undefined,
          measureRef: (el) => {
            if (!el) return;

            // eslint-disable-next-line compat/compat
            new ResizeObserver(([{ target }], ro) => {
              // NOTE: Use `borderBoxSize` when it's supported by Safari
              // see: https://caniuse.com/mdn-api_resizeobserverentry_borderboxsize
              const measuredSize = target.getBoundingClientRect()[sizeKey];

              if (!measuredSize) {
                ro.disconnect();
                rosRef.current.delete(target);
                return;
              }

              const prevEnd = msData[i - 1]?.end ?? 0;

              if (measuredSize !== size || start !== prevEnd) {
                if (i < prevItemIdxRef.current && start < scrollOffset)
                  scrollTo(scrollOffset + measuredSize - size);

                msDataRef.current[i] = getMeasure(i, measuredSize);
                handleScroll(scrollOffset, isScrolling, uxScrolling);

                hasDynamicSizeRef.current = true;
              }

              prevItemIdxRef.current = i;

              rosRef.current.get(target)?.disconnect();
              rosRef.current.set(target, ro);
            }).observe(el);
          },
        });
      }

      if (stickies.length) {
        const stickyIdx =
          stickies[
            findNearestBinarySearch(
              0,
              stickies.length - 1,
              vStart,
              (idx) => stickies[idx]
            )
          ];

        if (oStart > stickyIdx) {
          const { size } = msDataRef.current[stickyIdx];

          nextItems.unshift({
            index: stickyIdx,
            start: 0,
            size,
            width: outerRectRef.current.width,
            isScrolling: uxScrolling || undefined,
            isSticky: true,
            measureRef: () => null,
          });

          innerRef.current.style[marginKey] = `${margin - size}px`;
          innerRef.current.style[sizeKey] = `${innerSize + size}px`;
        }
      }

      setItems((prevItems) =>
        shouldUpdate(prevItems, nextItems, { measureRef: true })
          ? nextItems
          : prevItems
      );

      if (!isScrolling) return;

      if (onScrollRef.current)
        onScrollRef.current({
          overscanStartIndex: oStart,
          overscanStopIndex: oStop,
          visibleStartIndex: vStart,
          visibleStopIndex: vStop,
          scrollOffset,
          scrollForward: scrollOffset > scrollOffsetRef.current,
          userScroll: userScrollRef.current,
        });

      const loadIndex = Math.floor((vStop + 1) / loadMoreCount);
      const startIndex = loadIndex * loadMoreCount;

      if (
        loadMoreRef.current &&
        vStop !== prevVStopRef.current &&
        !(isItemLoadedRef.current && isItemLoadedRef.current(loadIndex))
      )
        loadMoreRef.current({
          startIndex,
          stopIndex: startIndex + loadMoreCount - 1,
          loadIndex,
          scrollOffset,
          userScroll: userScrollRef.current,
        });

      prevVStopRef.current = vStop;

      if (uxScrolling) resetIsScrolling();
      if (!userScrollRef.current) resetUserScroll();
    },
    [
      getCalcData,
      getMeasure,
      itemCount,
      loadMoreCount,
      loadMoreRef,
      marginKey,
      onScrollRef,
      resetIsScrolling,
      resetUserScroll,
      scrollTo,
      sizeKey,
    ]
  );

  useResizeEffect<O>(
    outerRef,
    (rect) => {
      const { width, height } = outerRectRef.current;
      const isSameWidth = width === rect.width;
      const isSameSize = isSameWidth && height === rect.height;
      const prevTotalSize =
        msDataRef.current[msDataRef.current.length - 1]?.end;

      outerRectRef.current = rect;
      measureItems(hasDynamicSizeRef.current);
      handleScroll(scrollOffsetRef.current);

      if (!hasDynamicSizeRef.current && !isSameWidth) {
        const totalSize = msDataRef.current[msDataRef.current.length - 1]?.end;
        const ratio = totalSize / prevTotalSize || 1;

        scrollTo(scrollOffsetRef.current * ratio);
      }

      if (isMountedRef.current && !isSameSize && onResizeRef.current)
        onResizeRef.current(rect);

      isMountedRef.current = true;
    },
    [itemCount, handleScroll, measureItems, onResizeRef, scrollTo]
  );

  useIsoLayoutEffect(() => {
    const { current: outer } = outerRef;

    if (!outer) return () => null;

    const scrollHandler = ({ target }: Event) => {
      const scrollOffset = (target as O)[scrollKey];

      if (scrollOffset === scrollOffsetRef.current) return;

      let { current: uxScrolling } = useIsScrollingRef;
      uxScrolling =
        typeof uxScrolling === "function"
          ? uxScrolling(Math.abs(scrollOffset - scrollOffsetRef.current))
          : uxScrolling;

      handleScroll(scrollOffset, true, uxScrolling);
      scrollOffsetRef.current = scrollOffset;
    };

    outer.addEventListener("scroll", scrollHandler, { passive: true });

    const ros = rosRef.current;

    return () => {
      cancelResetIsScrolling();
      cancelResetUserScroll();
      if (scrollToRafRef.current) {
        cancelAnimationFrame(scrollToRafRef.current);
        scrollToRafRef.current = undefined;
      }

      outer.removeEventListener("scroll", scrollHandler);

      ros.forEach((ro) => ro.disconnect());
      ros.clear();
    };
  }, [
    cancelResetIsScrolling,
    cancelResetUserScroll,
    handleScroll,
    scrollKey,
    useIsScrollingRef,
  ]);

  return { outerRef, innerRef, items, scrollTo: scrollToOffset, scrollToItem };
};
