import pandas as pd
import numpy as np
import math
import numbers
from datetime import date, timedelta
import ssl
import requests
import os

# Disable SSL certificate verification if needed
ssl._create_default_https_context = ssl._create_unverified_context

def Data_Pre(source_file):
    df1 = pd.read_csv(source_file, sep='\t', skiprows=2, nrows=24)
    df2 = pd.read_csv(source_file, sep='\t', skiprows=30, nrows=24, usecols=[0,1,2])
    block = df1.merge(df2, how='outer', on='HOUR')
    block = block.rename(columns={'MKT$':'BUY', 'MKT$.1':'SELL'})
    return block

def sanitize_dataframe(df):
    """
    Replace any NaN, Inf, or -Inf in numeric columns with 0,
    convert Timestamps to ISO strings,
    convert numpy types to native Python types.
    """
    def sanitize_value(x):
        # Handle pandas NaT (Not a Time)
        if pd.isna(x):
            return 0
        # Handle Timestamps
        if isinstance(x, pd.Timestamp):
            return x.isoformat()
        # Handle NaN, Inf, -Inf
        if isinstance(x, numbers.Real) and not isinstance(x, bool) and not math.isfinite(x):
            return 0
        # Handle numpy integers -> native Python int
        if isinstance(x, np.integer):
            return int(x)
        # Handle numpy floats -> native Python int (rounded)
        if isinstance(x, np.floating):
            return int(round(x))
        # Handle Python floats -> int (rounded)
        if isinstance(x, float):
            return int(round(x))
        return x
    
    return df.map(sanitize_value)

#______________________________________________________SCADA Data
def load_scada_data(scada_dir="Hydro Data"):
    """
    Load the most recent SCADA data file from the Hydro Data directory.
    Returns a single dict containing all 288 readings per column (full day).
    Note: File is named with today's date but contains yesterday's data.
    """
    today = date.today()
    filename = f"hydro_data_{today.strftime('%Y%m%d')}.xlsx"
    filepath = os.path.join(scada_dir, filename)

    if not os.path.exists(filepath):
        print(f"SCADA file not found!!!: {filepath}")
        return None

    scada = pd.read_excel(filepath)

    # Keep only TIME + data columns (drops extra time-like columns if they exist)
    data_cols = [col for col in scada.columns if 'TIME' not in col.upper() or col == 'TIME']
    scada = scada[data_cols]

    # Get the date from the first TIME value
    scada['TIME'] = pd.to_datetime(scada['TIME'])
    scada_date = scada['TIME'].iloc[0].strftime('%Y-%m-%d')  # Just the date, e.g., "2025-12-17"

    # Rename columns to be cleaner
    scada = scada.rename(columns={
        'Hydro_USC.KW-VAL': 'Hydro_USC_KW',
        'Lower_Snake_PLC.UNIT_1_KW-VAL': 'Lower_Snake_Unit1_KW',
        'Lower_Snake_PLC.UNIT_2_KW-VAL': 'Lower_Snake_Unit2_KW',
        'LakeCreek_GEN1.GEN_KW-VAL': 'LakeCreek_Gen1_KW',
        'Lake_Creek_BESS_1.ACTIVE_POWER_WATTS-VAL': 'LakeCreek_BESS1_Watts',
        'Lake_Creek_BESS_2.ACTIVE_POWER_WATTS-VAL': 'LakeCreek_BESS2_Watts'
    })

    # Data columns
    scada_cols = ['Hydro_USC_KW', 'Lower_Snake_Unit1_KW', 'Lower_Snake_Unit2_KW',
                  'LakeCreek_Gen1_KW', 'LakeCreek_BESS1_Watts', 'LakeCreek_BESS2_Watts']

    # Create ONE dict with ALL 288 readings per column
    scada_dict = {
        'date': scada_date  # Add date key
    }
    for col in scada_cols:
        if col in scada.columns:
            scada_dict[col] = [int(x) for x in scada[col].tolist()]  # All 288 values

    return scada_dict



if __name__ == "__main__":
    # File paths
    #source_yester = "https://px.uamps.com/members/heber/yesterlog.xls"
    #source_meta   = "https://px.uamps.com/members/heber/yestermet.xls"
    #source_tomor  = "https://px.uamps.com/members/heber/tomorlog.xls"
    
    source_yester = "yesterlog.xls"
    source_meta   = "yestermet.xls"
    source_tomor  = "tomorlog.xls"

    # API endpoint (only v3)
    ingest_url = "https://midaasforecast.com:443/midaas/v3/uamps/ingest"
    headers = {}

    # --- 1) Yesterday's block ---
    yest = Data_Pre(source_yester)
    yesterday = date.today() - timedelta(days=1)
    yest.insert(0, 'DATE', [yesterday]*len(yest))

    # Add Jordanelle metrics
    meta = pd.read_csv(source_meta, sep='\t')
    yest['Jrdn Loss']         = (meta['1130'] - meta['1132']).tolist()
    yest['Jrdn Heber share']  = meta['1133'].tolist()
    yest['UAMPS_Meter']       = meta['1100'].tolist()
    yest['Midway_Inter']      = meta['1132'].tolist()
    yest['Southfield_Inter1'] = meta['1106'].tolist()
    yest['Southfield_Inter2'] = meta['1108'].tolist()
    yest['Total_Natural_Gas'] = (meta['1110'] + meta['1120'] + meta['1112']).tolist()

    # Add SCADA data as a single dict column (same for all 24 rows)
    scada_dict = load_scada_data("Hydro Data")
    if scada_dict is not None:
        yest['SCADA'] = [scada_dict] * len(yest)  # Same dict with all 288 readings for all rows
        print(f"✅ SCADA data added")
    else:
        yest['SCADA'] = [{}] * len(yest)
        print("⚠️ Continuing without SCADA data!!!")

    # ISO‑format DATE
    yest['DATE'] = yest['DATE'].apply(lambda d: d.isoformat())

    # Ingest yesterday (with SCADA dict)
    payload_y = {'records': sanitize_dataframe(yest).to_dict(orient='records'),
                 'table_name': 'midass-tool-uamps-data'}
    r1 = requests.post(ingest_url, json=payload_y, headers=headers)
    r1.raise_for_status()
    print(f"✅ Yesterday pushed ({r1.status_code})")

    # Capture the schema from yesterday
    schema = list(yest.columns)

    #####################################2) Tomorrow's block and ingest #####################################
    tomo = Data_Pre(source_tomor)
    today = date.today()
    tomo.insert(0, 'DATE', [today]*len(tomo))

    tomo['DATE'] = tomo['DATE'].apply(lambda d: d.isoformat())

    tomo = sanitize_dataframe(tomo)

    # Ingest tomorrow
    payload_t = {'records': tomo.to_dict(orient='records'),
                 'table_name': 'midass-tool-uamps-tomorrow-data'}
    r3 = requests.post(ingest_url, json=payload_t, headers=headers)
    r3.raise_for_status()
    print(f"✅ Tomorrow pushed ({r3.status_code})")