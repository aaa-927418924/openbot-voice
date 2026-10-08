import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { ChannelHistoryControls } from "./ChannelHistoryControls";

describe("channel history controls", () => {
  it("hides mutations for an unsupported connection and archived channels", () => {
    const unsupported = render(() => (
      <ChannelHistoryControls
        channelName="Project"
        supported={false}
        archived={false}
        pending={false}
        onClear={vi.fn(async () => true)}
      />
    ));
    expect(screen.queryByRole("button", { name: "Clear channel history" })).not.toBeInTheDocument();

    unsupported.unmount();
    render(() => (
      <ChannelHistoryControls
        channelName="Project"
        supported
        archived
        pending={false}
        onClear={vi.fn(async () => true)}
      />
    ));
    expect(screen.queryByRole("button", { name: "Clear channel history" })).not.toBeInTheDocument();
  });

  it("shows an explicit confirmation before clearing the channel history", async () => {
    const onClear = vi.fn(async () => true);
    render(() => (
      <ChannelHistoryControls channelName="Project" supported archived={false} pending={false} onClear={onClear} />
    ));

    await fireEvent.click(screen.getByRole("button", { name: "Clear channel history" }));
    const dialog = screen.getByRole("alertdialog", { name: "Clear chat history for Project?" });
    expect(dialog).toHaveTextContent("Channel settings and tasks will remain.");
    expect(onClear).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    expect(onClear).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });
});
