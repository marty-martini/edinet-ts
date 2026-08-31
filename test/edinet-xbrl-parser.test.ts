import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { EdinetXbrlParser } from "../src/edinet-xbrl-parser";

describe("EdinetXbrlParser", () => {
    const TEST_DIR = path.resolve(__dirname, "./test_data");
    const EMPLOYEES_NUM_KEY = "jpcrp_cor:NumberOfEmployees";
    const ASSETS_NUM_KEY = "jppfs_cor:Assets";
    const NETSALES_KEY = "jppfs_cor:NetSales";

    const CURRENT_YEAR_INSTANT_CONTEXT = "CurrentYearInstant";
    const CURRENT_YEAR_DURATION_CONTEXT = "CurrentYearDuration";
    const CURRENT_YEAR_INSTANT_NON_CON_CONTEXT = "CurrentYearInstant_NonConsolidatedMember";
    const CURRENT_YEAR_DURATION_NON_CON_CONTEXT = "CurrentYearDuration_NonConsolidatedMember";

    const parser = new EdinetXbrlParser();

    /**
     * カカクコムのXBRLファイルを解析し、従業員数、資産、売上高が正しく取得できるかテストします。
     * このファイルはJ-GAAP基準です。
     */
    it("parses Kakaku.com XBRL correctly", () => {
        const xbrlFile = path.join(TEST_DIR, "CJ_2371_kakakucom.xbrl");
        const xml = fs.readFileSync(xbrlFile, "utf-8");
        const dataContainer = parser.parse(xml);

        // CJ_2371_kakakucom.yaml からの期待値
        // employees_num: 727
        // assets: 42129126000
        // netsales: 45089432000

        const employees = dataContainer.getDataByContextRef(EMPLOYEES_NUM_KEY, CURRENT_YEAR_INSTANT_CONTEXT);
        expect(employees).not.toBeNull();
        expect(parseInt(employees!.value)).toBe(727);

        const assets = dataContainer.getDataByContextRef(ASSETS_NUM_KEY, CURRENT_YEAR_INSTANT_CONTEXT);
        expect(assets).not.toBeNull();
        expect(parseInt(assets!.value)).toBe(42129126000);

        const netsales = dataContainer.getDataByContextRef(NETSALES_KEY, CURRENT_YEAR_DURATION_CONTEXT);
        expect(netsales).not.toBeNull();
        expect(parseInt(netsales!.value)).toBe(45089432000);
    });

    /**
     * LINEヤフーのXBRLファイルを解析し、同様に正しい値が取得できるかテストします。
     * このケースでは非連結（NonConsolidated）コンテキストからのデータ抽出を確認しています。
     */
    it("parses Yahoo XBRL correctly", () => {
        const xbrlFile = path.join(TEST_DIR, "CI_4689_yahoo.xbrl");
        const xml = fs.readFileSync(xbrlFile, "utf-8");
        const dataContainer = parser.parse(xml);

        // CI_4689_yahoo.yaml からの期待値
        // employees_num: 5826
        // assets: 1066775000000
        // netsales: 406793000000

        const employees = dataContainer.getDataByContextRef(EMPLOYEES_NUM_KEY, CURRENT_YEAR_INSTANT_NON_CON_CONTEXT);
        expect(employees).not.toBeNull();
        expect(parseInt(employees!.value)).toBe(5826);

        const assets = dataContainer.getDataByContextRef(ASSETS_NUM_KEY, CURRENT_YEAR_INSTANT_NON_CON_CONTEXT);
        expect(assets).not.toBeNull();
        expect(parseInt(assets!.value)).toBe(1066775000000);

        const netsales = dataContainer.getDataByContextRef(NETSALES_KEY, CURRENT_YEAR_DURATION_NON_CON_CONTEXT);
        expect(netsales).not.toBeNull();
        expect(parseInt(netsales!.value)).toBe(406793000000);
    });

    /**
     * ラクーンホールディングス（3031）のXBRLファイルを解析できるかテストします。
     * 売上高、営業利益、経常利益、当期純利益の抽出を確認します。
     */
    it("parses Raccoon Holdings (3031) XBRL correctly", () => {
        const xbrlFile = path.join(TEST_DIR, "3031_raccoon.xbrl");
        const xml = fs.readFileSync(xbrlFile, "utf-8");
        const dataContainer = parser.parse(xml);

        // 2024-07-30 有報 (DocID: S100U4EY) から検証した値
        // NetSales: 5,808,066,000
        // OperatingIncome: 566,962,000
        // OrdinaryIncome: 535,861,000
        // NetIncome: 325,982,000

        const netsales = dataContainer.getDataByContextRef(NETSALES_KEY, CURRENT_YEAR_DURATION_CONTEXT);
        expect(netsales).not.toBeNull();
        expect(parseInt(netsales!.value)).toBe(5808066000);

        const operatingIncome = dataContainer.getDataByContextRef("jppfs_cor:OperatingIncome", CURRENT_YEAR_DURATION_CONTEXT);
        expect(operatingIncome).not.toBeNull();
        expect(parseInt(operatingIncome!.value)).toBe(566962000);

        const ordinaryIncome = dataContainer.getDataByContextRef("jppfs_cor:OrdinaryIncome", CURRENT_YEAR_DURATION_CONTEXT);
        expect(ordinaryIncome).not.toBeNull();
        expect(parseInt(ordinaryIncome!.value)).toBe(535861000);

        const netIncome = dataContainer.getDataByContextRef("jppfs_cor:ProfitLossAttributableToOwnersOfParent", CURRENT_YEAR_DURATION_CONTEXT);
        expect(netIncome).not.toBeNull();
        expect(parseInt(netIncome!.value)).toBe(325982000);
    });

    /**
     * `getKeyMetrics` メソッドを使用して、主要な財務指標を一括で抽出できるかテストします。
     * IFRS基準（Yahoo）とJ-GAAP基準（Raccoon）の両方で正しい値が取得できるかを確認します。
     * EPS、BPS、自己資本比率、ROEなどの指標も検証対象です。
     */
    it("extracts KeyMetrics object correctly", () => {
        // Test with Yahoo (4689)
        const xmlYahoo = fs.readFileSync(path.join(TEST_DIR, "CI_4689_yahoo.xbrl"), "utf-8");
        const yahoo = parser.parse(xmlYahoo);
        const ym = yahoo.getKeyMetrics();
        expect(ym.netSales).toBe(853730000000); // IFRS 連結収益
        // このファイルの連結営業利益は企業固有拡張タグ(jpcrp030000-asr_...:OperatingIncomeIFRSSummaryOfBusinessResults)
        // にのみ存在し、既知タグ候補では検出できない。修正前は連結側に見つからず単体値(185,012,000,000円)に
        // 誤ってフォールバックしていたが、修正後は単体へのフォールバックをせずundefinedを返す（issue #7）。
        expect(ym.operatingIncome).toBeUndefined();
        expect(ym.netAssets).toBe(930820000000); // IFRS 連結資本

        // 新しい指標のチェック (debug/grep から導出)
        // Yahooはこのファイルで非連結を使用
        // EPS: 23.72
        expect(ym.earningsPerShare).toBe(23.99); // IFRS EPS
        // 1株当たり指標は決算短信様式の慣習上、単体コンテキストにのみ記載されることが多いため、
        // 従来通り連結→単体のフラット探索を維持し、単体値(150.59)も採用する（issue #7の対象外）。
        expect(ym.bookValuePerShare).toBe(150.59); // grepから
        expect(ym.numberOfIssuedShares).toBe(5695577000);
        expect(ym.equityToTotalAssetsRatio).toBeCloseTo(0.607, 3); // IFRS 連結比率
        expect(ym.rateOfReturnOnEquity).toBe(0.154); // IFRS 値
        expect(ym.dividendPaidPerShare).toBe(8.86);

        // Raccoon (3031) でテスト
        const xmlRaccoon = fs.readFileSync(path.join(TEST_DIR, "3031_raccoon.xbrl"), "utf-8");
        const raccoon = parser.parse(xmlRaccoon);
        const rm = raccoon.getKeyMetrics();
        expect(rm.netSales).toBe(5808066000);
        expect(rm.operatingCashFlow).toBe(660987000); // 連結値
        expect(rm.operatingIncome).toBe(566962000);
        expect(rm.netIncome).toBe(325982000);
        expect(rm.numberOfIssuedShares).toBe(22235143);
        expect(rm.equityToTotalAssetsRatio).toBe(0.311);
        expect(rm.rateOfReturnOnEquity).toBe(0.065);
        // Raccoonのデバッグログ: "jpcrp_cor:TotalNumberOfIssuedSharesSummaryOfBusinessResults: 20176043"
        // 20176043を使用します。
        // 18636800 は別のコンテキストでしょうか？最新は 20176043 です。
        // 20176043 を入力して検証します。
    });

    /**
     * `dataMap` プロパティが公開されており、直接アクセスできることを確認します。
     * これにより、ユーザーはパースされた全データに対する低レベルアクセスが可能になります。
     */
    it("exposes dataMap for direct access", () => {
        const xbrlFile = path.join(TEST_DIR, "3031_raccoon.xbrl");
        const xml = fs.readFileSync(xbrlFile, "utf-8");
        const dataContainer = parser.parse(xml);

        // dataMap should be accessible and be a Map
        expect(dataContainer.dataMap).toBeDefined();
        expect(dataContainer.dataMap instanceof Map).toBe(true);

        // Should have data
        expect(dataContainer.dataMap.size).toBeGreaterThan(0);

        // Should be able to access NetSales data via dataMap
        const netSalesData = dataContainer.dataMap.get(NETSALES_KEY);
        expect(netSalesData).toBeDefined();
        expect(Array.isArray(netSalesData)).toBe(true);
        expect(netSalesData!.length).toBeGreaterThan(0);

        // Should match getDataList result
        const netSalesViaMethod = dataContainer.getDataList(NETSALES_KEY);
        expect(netSalesData).toEqual(netSalesViaMethod);
    });
});
