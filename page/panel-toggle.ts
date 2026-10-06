// 侧栏开关只等待真实回执；不按时间丢弃用户已完成的下一次右键。
type Ports = {
  visible(): boolean;
  request(action: "open" | "close"): Promise<unknown>;
  changed(pending: boolean): void;
};
export class PanelToggle {
  private pending = false;
  private ports: Ports;
  constructor(ports: Ports) {
    this.ports = ports;
  }
  async toggle(): Promise<boolean> {
    if (this.pending) return false;
    this.pending = true;
    this.ports.changed(true);
    try {
      // 请求同步进入 runtime 消息，保留本次真实用户激活；不先 await 状态查询。
      await this.ports.request(this.ports.visible() ? "close" : "open");
      return true;
    } finally {
      this.pending = false;
      this.ports.changed(false);
    }
  }
}
