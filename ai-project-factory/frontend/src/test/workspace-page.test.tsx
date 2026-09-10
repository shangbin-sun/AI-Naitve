import { expect, it } from "vitest";
import { render } from "@testing-library/react";
import WorkspacePage from "../WorkspacePage";

it("keeps the background locked until the last detail page closes, then restores its style", () => {
  document.body.style.overflow = "auto";
  const page = (parent: boolean, child: boolean) => (
    <>
      <WorkspacePage open={parent} title="AI 团队">
        AI 团队内容
      </WorkspacePage>
      <WorkspacePage open={child} title="员工">
        员工内容
      </WorkspacePage>
    </>
  );
  const view = render(page(true, true));
  expect(document.body.style.overflow).toBe("hidden");
  view.rerender(page(true, false));
  expect(document.body.style.overflow).toBe("hidden");
  view.rerender(page(false, false));
  expect(document.body.style.overflow).toBe("auto");
  view.rerender(page(true, true));
  view.unmount();
  expect(document.body.style.overflow).toBe("auto");
  document.body.style.overflow = "";
});
