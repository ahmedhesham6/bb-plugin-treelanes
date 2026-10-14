// @vitest-environment jsdom
import { useRef } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useSelectionAnchor } from "./useSelectionAnchor";
afterEach(cleanup);
it("compensates for the height removed above the clicked row before paint", () => {
  let top = 500;
  function List({ expanded }: { expanded: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const capture = useSelectionAnchor(ref, expanded);
    return (
      <div ref={ref} data-testid="scroll">
        <a
          data-sidebar-thread-id="b"
          ref={(node) => {
            if (node) node.getBoundingClientRect = () => ({ top }) as DOMRect;
          }}
          onClick={() => capture("b", "b")}
        >
          B
        </a>
      </div>
    );
  }
  const view = render(<List expanded="a" />);
  const scroll = view.getByTestId("scroll");
  scroll.scrollTop = 600;
  fireEvent.click(view.getByText("B"));
  top = 240;
  view.rerender(<List expanded="b" />);
  expect(scroll.scrollTop).toBe(340);
  top = 100;
  view.rerender(<List expanded="c" />);
  expect(scroll.scrollTop).toBe(340);
});
