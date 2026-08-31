import { describe, it, expect, beforeEach } from "vitest";
import { EdinetXbrlObject, EdinetData } from "../src/edinet-xbrl-object";
import { EdinetContext } from "../src/edinet-context";

describe("EdinetXbrlObject", () => {
    let xbrlObject: EdinetXbrlObject;

    beforeEach(() => {
        xbrlObject = new EdinetXbrlObject();
    });

    describe("Data Storage", () => {
        /**
         * キーとコンテキスト参照（contextRef）を使ってデータを正しく格納・取得できるか確認します。
         */
        it("stores and retrieves data by key and contextRef", () => {
            const data1 = new EdinetData("NetSales", "1000", 0, "JPY", "ctx1");
            const data2 = new EdinetData("NetSales", "2000", 0, "JPY", "ctx2");

            xbrlObject.put("NetSales", data1);
            xbrlObject.put("NetSales", data2);

            expect(xbrlObject.getDataByContextRef("NetSales", "ctx1")).toEqual(data1);
            expect(xbrlObject.getDataByContextRef("NetSales", "ctx2")).toEqual(data2);
            expect(xbrlObject.getDataByContextRef("NetSales", "ctx3")).toBeNull();
        });
    });

    describe("Context Logic", () => {
        const createCtx = (id: string, endDate: string, scope: "Consolidated" | "NonConsolidated", dims: string[] = []): EdinetContext => ({
            id,
            period: { startDate: "2023-04-01", endDate },
            scope,
            dimensions: dims
        });

        beforeEach(() => {
            xbrlObject.addContext(createCtx("c_recent_cons", "2024-03-31", "Consolidated"));
            xbrlObject.addContext(createCtx("c_old_cons", "2023-03-31", "Consolidated"));
            xbrlObject.addContext(createCtx("c_recent_non", "2024-03-31", "NonConsolidated", ["NonConsolidatedMember"]));
            xbrlObject.addContext(createCtx("c_invalid_dim", "2024-03-31", "Consolidated", ["SomeSegment"])); // Should be ignored
        });

        /**
         * 連結（Consolidated）スコープのコンテキストを検索し、日付順で取得できるかテストします。
         */
        it("finds Consolidated contexts sorted by date", () => {
            const ctxs = xbrlObject.findContexts({ type: "Duration", scope: "Consolidated" });
            expect(ctxs).toHaveLength(2);
            expect(ctxs[0].id).toBe("c_recent_cons");
            expect(ctxs[1].id).toBe("c_old_cons");
        });

        /**
         * 想定外のディメンションを持つコンテキストが、検索結果から除外されることを確認します。
         */
        it("excludes contexts with unexpected dimensions", () => {
            // c_invalid_dim はスコープはConsolidatedですが、余分なディメンションを持つため除外されるべきです
            const ctxs = xbrlObject.findContexts({ type: "Duration", scope: "Consolidated" });
            const ids = ctxs.map(c => c.id);
            expect(ids).not.toContain("c_invalid_dim");
        });

        /**
         * 非連結（NonConsolidated）スコープのコンテキストを正しく検索できるかテストします。
         */
        it("finds NonConsolidated contexts", () => {
            const ctxs = xbrlObject.findContexts({ type: "Duration", scope: "NonConsolidated" });
            expect(ctxs).toHaveLength(1);
            expect(ctxs[0].id).toBe("c_recent_non");
        });

        /**
         * 「当期」「前期」といった年の相対指定（Year offset）でコンテキストを検索できるか確認します。
         */
        it("handles Year offset", () => {
            const current = xbrlObject.findContext({ type: "Duration", scope: "Consolidated", year: "Current" });
            const prior = xbrlObject.findContext({ type: "Duration", scope: "Consolidated", year: "Prior1Year" });

            expect(current?.id).toBe("c_recent_cons");
            expect(prior?.id).toBe("c_old_cons");
        });
    });

    describe("getKeyMetrics", () => {
        /**
         * 連結データを優先して主要指標を抽出することを確認します。
         */
        it("extracts metrics prioritizing Consolidated", () => {
            // Setup contexts
            const consCtx = { id: "cons_2024", period: { startDate: "2023-04-01", endDate: "2024-03-31" }, scope: "Consolidated", dimensions: [] } as any;
            const nonConsCtx = { id: "non_2024", period: { startDate: "2023-04-01", endDate: "2024-03-31" }, scope: "NonConsolidated", dimensions: ["NonConsolidatedMember"] } as any;

            xbrlObject.addContext(consCtx);
            xbrlObject.addContext(nonConsCtx);

            // Setup data
            xbrlObject.put("jppfs_cor:NetSales", new EdinetData("jppfs_cor:NetSales", "1000", 0, "JPY", "cons_2024"));
            xbrlObject.put("jppfs_cor:NetSales", new EdinetData("jppfs_cor:NetSales", "500", 0, "JPY", "non_2024"));

            const metrics = xbrlObject.getKeyMetrics();
            expect(metrics.netSales).toBe(1000);
        });

        /**
         * 連結データがない場合、非連結データにフォールバックすることを確認します。
         */
        it("falls back to NonConsolidated if Consolidated missing", () => {
            // Setup contexts
            const nonConsCtx = { id: "non_2024", period: { startDate: "2023-04-01", endDate: "2024-03-31" }, scope: "NonConsolidated", dimensions: ["NonConsolidatedMember"] } as any;
            xbrlObject.addContext(nonConsCtx);

            // Setup data
            xbrlObject.put("jppfs_cor:NetSales", new EdinetData("jppfs_cor:NetSales", "500", 0, "JPY", "non_2024"));

            const metrics = xbrlObject.getKeyMetrics();
            expect(metrics.netSales).toBe(500);
        });

        /**
         * IFRS基準のタグからも指標を抽出できることをテストします。
         */
        it("extracts IFRS metrics", () => {
            const ctx = { id: "ifrs_2024", period: { startDate: "2023-04-01", endDate: "2024-03-31" }, scope: "Consolidated", dimensions: [] } as any;
            xbrlObject.addContext(ctx);

            xbrlObject.put("jpcrp_cor:RevenueIFRSSummaryOfBusinessResults", new EdinetData("jpcrp_cor:RevenueIFRSSummaryOfBusinessResults", "9999", 0, "JPY", "ifrs_2024"));
            xbrlObject.put("jpcrp_cor:ProfitLossAttributableToOwnersOfParentIFRSSummaryOfBusinessResults", new EdinetData("...", "888", 0, "JPY", "ifrs_2024"));

            const metrics = xbrlObject.getKeyMetrics();
            expect(metrics.netSales).toBe(9999);
            expect(metrics.netIncome).toBe(888);
        });

        /**
         * IFRS企業のように連結コンテキストに対象タグが1件も無い場合、
         * 単体コンテキストの値を誤って返さず undefined になることを確認します（issue #7）。
         */
        it("does not fall back to NonConsolidated value when Consolidated context exists but lacks the tag", () => {
            const consCtx = { id: "cons_2024", period: { startDate: "2023-04-01", endDate: "2024-03-31" }, scope: "Consolidated", dimensions: [] } as any;
            const nonConsCtx = { id: "non_2024", period: { startDate: "2023-04-01", endDate: "2024-03-31" }, scope: "NonConsolidated", dimensions: ["NonConsolidatedMember"] } as any;

            xbrlObject.addContext(consCtx);
            xbrlObject.addContext(nonConsCtx);

            // 連結コンテキストには jppfs_cor:NetSales が存在せず（IFRS企業でよくあるケース）、
            // 単体コンテキストにのみ存在する状況を再現する。
            xbrlObject.put("jppfs_cor:NetSales", new EdinetData("jppfs_cor:NetSales", "500", 0, "JPY", "non_2024"));

            const metrics = xbrlObject.getKeyMetrics();
            expect(metrics.netSales).toBeUndefined();
        });
    });

    describe("getQualitativeInfo", () => {
        /**
         * 事業リスクや事業内容などの定性的なテキスト情報を抽出できるかテストします。
         */
        it("extracts qualitative text blocks", () => {
            xbrlObject.put("jpcrp_cor:BusinessRisksTextBlock", new EdinetData("jpcrp_cor:BusinessRisksTextBlock", "Risks are...", 0, "", "ctx1"));
            xbrlObject.put("jpcrp_cor:DescriptionOfBusinessTextBlock", new EdinetData("jpcrp_cor:DescriptionOfBusinessTextBlock", "We sell widgets.", 0, "", "ctx1"));

            const info = xbrlObject.getQualitativeInfo();
            expect(info.businessRisks).toBe("Risks are...");
            expect(info.businessDescription).toBe("We sell widgets.");
            expect(info.companyHistory).toBeUndefined();
        });

        /**
         * 代替タグ（alternative tags）が定義されている項目について、優先タグがない場合に代替タグから値を取得することを確認します。
         */
        it("handles alternative tags", () => {
            // Example of checking alternative tag priority if one is missing
            xbrlObject.put("jpcrp_cor:DescriptionOfBusinessPolicyEnvironmentAndIssuesToAddressTextBlock", new EdinetData("jpcrp_cor:...", "Policy B", 0, "", "ctx1"));

            const info = xbrlObject.getQualitativeInfo();
            expect(info.businessPolicy).toBe("Policy B");
        });

        /**
         * HTMLタグとエスケープされたHTML実体が除去されることを確認します。
         */
        it("removes HTML tags and entities from qualitative text", () => {
            // Escaped HTML entities like in real EDINET data
            const htmlText = '&lt;p style="page-break-before:always;"&gt; &lt;/p&gt;&lt;h3 class="smt_head2"&gt;３ 【事業等のリスク】&lt;/h3&gt;&lt;p class="smt_text2"&gt;当社の事業内容、経営成績及び財政状態等に関するリスク要因について&lt;/p&gt;';
            
            xbrlObject.put("jpcrp_cor:BusinessRisksTextBlock", new EdinetData("jpcrp_cor:BusinessRisksTextBlock", htmlText, 0, "", "ctx1"));

            const info = xbrlObject.getQualitativeInfo();
            
            // Should contain the text content
            expect(info.businessRisks).toContain('３ 【事業等のリスク】');
            expect(info.businessRisks).toContain('当社の事業内容、経営成績及び財政状態等に関するリスク要因について');
            
            // Should not contain HTML tags or entities
            expect(info.businessRisks).not.toContain('<');
            expect(info.businessRisks).not.toContain('>');
            expect(info.businessRisks).not.toContain('&lt;');
            expect(info.businessRisks).not.toContain('&gt;');
            expect(info.businessRisks).not.toContain('style=');
            expect(info.businessRisks).not.toContain('class=');
        });
    });
});
