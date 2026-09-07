// Stand-in for Salesforce responses. Shaped exactly like the real
// salesforceService return values so swapping SF_MOCK=false requires no
// route/controller changes — only salesforceService.js talks to this file.

const stores = [
  { storeId: "001MOCK0000STORE1", storeNumber: "4021", storeName: "Riverside Plaza" },
  { storeId: "001MOCK0000STORE2", storeNumber: "4088", storeName: "Harbor Point Center" },
];

// Account_Rack__c mock records. `qrCode` is the value we expect the printed
// QR code on the physical rack to contain.
const racks = {
  "001MOCK0000STORE1": [
    { id: "a01MOCK000RACK001", qrCode: "RACK-4021-01", label: "Frozen Aisle · Bay 1", isActive: true, status: "Not Verified" },
    { id: "a01MOCK000RACK002", qrCode: "RACK-4021-02", label: "Frozen Aisle · Bay 2", isActive: true, status: "Not Verified" },
    { id: "a01MOCK000RACK003", qrCode: "RACK-4021-03", label: "Dairy · Bay 1", isActive: true, status: "Not Verified" },
    { id: "a01MOCK000RACK004", qrCode: "RACK-4021-04", label: "Checkout Endcap · Bay 4", isActive: true, status: "Not Verified" },
    { id: "a01MOCK000RACK005", qrCode: "RACK-4021-05", label: "Bakery · Bay 2", isActive: false, status: "Not Verified" },
  ],
  "001MOCK0000STORE2": [
    { id: "a01MOCK000RACK101", qrCode: "RACK-4088-01", label: "Produce · Bay 1", isActive: true, status: "Not Verified" },
    { id: "a01MOCK000RACK102", qrCode: "RACK-4088-02", label: "Beverage Aisle · Bay 3", isActive: true, status: "Not Verified" },
    { id: "a01MOCK000RACK103", qrCode: "RACK-4088-03", label: "Snacks · Bay 2", isActive: true, status: "Not Verified" },
  ],
};

function findStore(query) {
  const q = String(query).trim().toLowerCase();
  return stores.find(
    (s) => s.storeNumber.toLowerCase() === q || s.storeName.toLowerCase().includes(q)
  );
}

function getRacksForStore(storeId) {
  return racks[storeId] || [];
}

function findRackByQr(storeId, qrCode) {
  return (racks[storeId] || []).find((r) => r.qrCode === qrCode);
}

function updateRackStatus(storeId, rackId, status) {
  const rack = (racks[storeId] || []).find((r) => r.id === rackId);
  if (rack) rack.status = status;
  return rack;
}

module.exports = { stores, findStore, getRacksForStore, findRackByQr, updateRackStatus };
