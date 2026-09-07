import { describe, it, expect } from "vitest";
import { EdinetXbrlParser } from "../src/edinet-xbrl-parser";
import * as path from "path";
import * as fs from "fs";

/**
 * トヨタ自動車（IFRS基準）の実データを用いた回帰テストです。
 *
 * トヨタのような大手IFRS企業は、連結損益計算書の「売上高」「営業利益」に
 * 企業独自の名前空間拡張タグ（例: "TotalNetRevenuesIFRS"）や、標準の
 * jpigp_cor タクソノミ（"jpigp_cor:OperatingProfitLossIFRS"）を用いており、
 * 従来の候補タグリストには含まれていなかったため netSales / operatingIncome が
 * undefined になっていた。
 */
describe("Integration Test - Annual Report Financials (Toyota, IFRS)", () => {
    const parser = new EdinetXbrlParser();
    // 有価証券報告書（docTypeCode: 120）: S100Y8NY
    const toyotaPath = path.resolve(__dirname, "test_data/annual_reports/S100Y8NY.xbrl");

    it("parses netSales and operatingIncome from Toyota's consolidated (IFRS) statements", () => {
        if (!fs.existsSync(toyotaPath)) {
            console.warn("Skipping (fixture not found)");
            return;
        }

        const xml = fs.readFileSync(toyotaPath, "utf-8");
        const data = parser.parse(xml);
        const metrics = data.getKeyMetrics();

        expect(metrics.netSales).toBe(50684952000000);
        expect(metrics.operatingIncome).toBe(3766216000000);
    });

    /**
     * IFRS企業には経常利益（J-GAAP特有の概念）が存在しないため ordinaryIncome は undefined
     * のままとなる一方、税引前利益（profitBeforeTax）はJ-GAAP・IFRS共通の概念として
     * 取得できることを確認する。
     */
    it("parses profitBeforeTax but not ordinaryIncome for an IFRS filer", () => {
        if (!fs.existsSync(toyotaPath)) {
            console.warn("Skipping (fixture not found)");
            return;
        }

        const xml = fs.readFileSync(toyotaPath, "utf-8");
        const data = parser.parse(xml);
        const metrics = data.getKeyMetrics();

        expect(metrics.profitBeforeTax).toBe(5152996000000);
        expect(metrics.ordinaryIncome).toBeUndefined();
    });
});
