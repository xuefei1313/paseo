import { useCallback } from "react";
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { DesktopDirectory } from "./client/directory.js";

function Sidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "desktop" }), [openScreen]);
  return (
    <SidebarRow
      icon="Laptop"
      label="Codex Desktop"
      active={currentScreen?.screenId === "desktop"}
      onPress={open}
    />
  );
}
export default function contribute(client: PluginClientContext) {
  const screen = client.addScreen({
    id: "desktop",
    title: "Codex Desktop",
    Component: DesktopDirectory,
  });
  const sidebar = client.addSidebarHeaderItem({
    id: "desktop",
    title: "Codex Desktop",
    Component: Sidebar,
  });
  return () => {
    screen();
    sidebar();
  };
}
