-- =============================================================================
--  Seed: the 47 counties of Kenya (official codes, Constitution of Kenya 2010,
--  First Schedule) + Nairobi's 17 sub-counties. Idempotent: safe to re-run.
--  Other sub-counties are added on demand from the landlord onboarding form.
-- =============================================================================
BEGIN;

INSERT INTO counties (id, name, region) VALUES
    ( 1, 'Mombasa',         'Coast'),
    ( 2, 'Kwale',           'Coast'),
    ( 3, 'Kilifi',          'Coast'),
    ( 4, 'Tana River',      'Coast'),
    ( 5, 'Lamu',            'Coast'),
    ( 6, 'Taita-Taveta',    'Coast'),
    ( 7, 'Garissa',         'North Eastern'),
    ( 8, 'Wajir',           'North Eastern'),
    ( 9, 'Mandera',         'North Eastern'),
    (10, 'Marsabit',        'Eastern'),
    (11, 'Isiolo',          'Eastern'),
    (12, 'Meru',            'Eastern'),
    (13, 'Tharaka-Nithi',   'Eastern'),
    (14, 'Embu',            'Eastern'),
    (15, 'Kitui',           'Eastern'),
    (16, 'Machakos',        'Eastern'),
    (17, 'Makueni',         'Eastern'),
    (18, 'Nyandarua',       'Central'),
    (19, 'Nyeri',           'Central'),
    (20, 'Kirinyaga',       'Central'),
    (21, 'Murang''a',       'Central'),
    (22, 'Kiambu',          'Central'),
    (23, 'Turkana',         'Rift Valley'),
    (24, 'West Pokot',      'Rift Valley'),
    (25, 'Samburu',         'Rift Valley'),
    (26, 'Trans Nzoia',     'Rift Valley'),
    (27, 'Uasin Gishu',     'Rift Valley'),
    (28, 'Elgeyo-Marakwet', 'Rift Valley'),
    (29, 'Nandi',           'Rift Valley'),
    (30, 'Baringo',         'Rift Valley'),
    (31, 'Laikipia',        'Rift Valley'),
    (32, 'Nakuru',          'Rift Valley'),
    (33, 'Narok',           'Rift Valley'),
    (34, 'Kajiado',         'Rift Valley'),
    (35, 'Kericho',         'Rift Valley'),
    (36, 'Bomet',           'Rift Valley'),
    (37, 'Kakamega',        'Western'),
    (38, 'Vihiga',          'Western'),
    (39, 'Bungoma',         'Western'),
    (40, 'Busia',           'Western'),
    (41, 'Siaya',           'Nyanza'),
    (42, 'Kisumu',          'Nyanza'),
    (43, 'Homa Bay',        'Nyanza'),
    (44, 'Migori',          'Nyanza'),
    (45, 'Kisii',           'Nyanza'),
    (46, 'Nyamira',         'Nyanza'),
    (47, 'Nairobi',         'Nairobi')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, region = EXCLUDED.region;

INSERT INTO sub_counties (county_id, name)
SELECT 47, n FROM unnest(ARRAY[
    'Westlands', 'Dagoretti North', 'Dagoretti South', 'Lang''ata', 'Kibra',
    'Roysambu', 'Kasarani', 'Ruaraka', 'Embakasi South', 'Embakasi North',
    'Embakasi Central', 'Embakasi East', 'Embakasi West', 'Makadara',
    'Kamukunji', 'Starehe', 'Mathare'
]) AS n
ON CONFLICT (county_id, name) DO NOTHING;

COMMIT;
