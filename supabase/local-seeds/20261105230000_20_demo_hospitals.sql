-- DEMO PROJECT ONLY. Fictional hospitals and SIMULATED stock; never deploy to production.
-- Set medinexus.demo_seed=enabled explicitly in this SQL session before running.
BEGIN;
DO $$
DECLARE v_actor uuid; v_expected integer;
BEGIN
  IF current_setting('medinexus.demo_seed', true) IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'Demo seed blocked; explicitly SET medinexus.demo_seed = enabled in this session';
  END IF;
  -- Wrong-project guard: both known demo facility IDs and names must match.
  IF NOT EXISTS (SELECT 1 FROM public.facilities WHERE id='7da05698-b748-4e79-b99e-3abcbdcb1001' AND name='MediNexus Demo Clinic' AND facility_type='CLINIC')
     OR NOT EXISTS (SELECT 1 FROM public.facilities WHERE id='7da05698-b748-4e79-b99e-3abcbdcb1002' AND name='MediNexus Demo Pharmacy' AND facility_type='PHARMACY') THEN
    RAISE EXCEPTION 'Wrong database: known MediNexus demo clinic and pharmacy IDs/names are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.medicines WHERE id='9ee2a001-c270-4eca-8c10-f7df1c110001' AND name='Paracetamol' AND strength='500 mg' AND dosage_form='tablet' AND unit_of_measure='tablet')
     OR NOT EXISTS (SELECT 1 FROM public.medicines WHERE id='9ee2a001-c270-4eca-8c10-f7df1c110002' AND name='Amoxicillin' AND strength='250 mg' AND dosage_form='capsule' AND unit_of_measure='capsule') THEN
    RAISE EXCEPTION 'Wrong database: known MediNexus demo catalogue IDs/formulations are required';
  END IF;
  SELECT id INTO v_actor FROM public.profiles WHERE role='PLATFORM_ADMIN' AND account_status='ACTIVE' ORDER BY id LIMIT 1;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'An existing active PLATFORM_ADMIN profile is required'; END IF;

  CREATE TEMP TABLE _mn_facility(n int PRIMARY KEY,id uuid UNIQUE,name text,address text) ON COMMIT DROP;
  INSERT INTO _mn_facility
  SELECT n,('b9f45f20-a061-4fe1-9b34-'||lpad(n::text,12,'0'))::uuid,
    'MediNexus Demo/Fictional Hospital '||to_char(n,'FM00'),
    'Fictional placeholder address '||to_char(n,'FM00')||' (no real location)'
  FROM generate_series(1,20) n;
  IF EXISTS (SELECT 1 FROM _mn_facility s JOIN public.facilities f ON f.id=s.id
      WHERE (f.name,f.facility_type,f.address,f.latitude,f.longitude,f.verification_status,f.operational_status,f.verification_valid_until) IS DISTINCT FROM
            (s.name,'HOSPITAL',s.address,NULL::double precision,NULL::double precision,'UNVERIFIED','ACTIVE',NULL::date)) THEN
    RAISE EXCEPTION 'A deterministic demo hospital ID is occupied by conflicting facility data';
  END IF;
  INSERT INTO public.facilities(id,name,facility_type,address,latitude,longitude,verification_status)
  SELECT id,name,'HOSPITAL',address,NULL,NULL,'UNVERIFIED' FROM _mn_facility ON CONFLICT(id) DO NOTHING;

  CREATE TEMP TABLE _mn_medicine(n int PRIMARY KEY,id uuid UNIQUE,name text,generic_name text,active_ingredient text,
    strength text,dosage_form text,unit_of_measure text) ON COMMIT DROP;
  INSERT INTO _mn_medicine VALUES
    (1,'9ee2a001-c270-4eca-8c10-f7df1c110001','Paracetamol','Paracetamol','Paracetamol','500 mg','tablet','tablet'),
    (2,'9ee2a001-c270-4eca-8c10-f7df1c110002','Amoxicillin','Amoxicillin','Amoxicillin','250 mg','capsule','capsule'),
    (3,'9ee2a002-c270-4eca-8c10-f7df1c110001','Paracetamol','Paracetamol','Paracetamol','1 g','tablet','tablet'),
    (4,'9ee2a002-c270-4eca-8c10-f7df1c110002','Amoxicillin','Amoxicillin','Amoxicillin','500 mg','capsule','capsule'),
    (5,'9ee2a002-c270-4eca-8c10-f7df1c110003','Ibuprofen','Ibuprofen','Ibuprofen','200 mg','tablet','tablet'),
    (6,'9ee2a002-c270-4eca-8c10-f7df1c110004','Oral Rehydration Salts','Oral Rehydration Salts','Oral Rehydration Salts','20.5 g','powder sachet','sachet'),
    (7,'9ee2a002-c270-4eca-8c10-f7df1c110005','Cetirizine','Cetirizine','Cetirizine','10 mg','tablet','tablet'),
    (8,'9ee2a002-c270-4eca-8c10-f7df1c110006','Metformin','Metformin','Metformin','500 mg','tablet','tablet'),
    (9,'9ee2a002-c270-4eca-8c10-f7df1c110007','Omeprazole','Omeprazole','Omeprazole','20 mg','capsule','capsule');
  IF EXISTS (SELECT 1 FROM _mn_medicine s JOIN public.medicines m ON m.id=s.id
      WHERE (m.name,m.generic_name,m.brand_name,m.active_ingredient,m.strength,m.dosage_form,m.unit_of_measure) IS DISTINCT FROM
            (s.name,s.generic_name,NULL::text,s.active_ingredient,s.strength,s.dosage_form,s.unit_of_measure)) THEN
    RAISE EXCEPTION 'A deterministic demo medicine ID is occupied by conflicting catalogue data';
  END IF;
  IF EXISTS (SELECT 1 FROM _mn_medicine s JOIN public.medicines m
      ON (m.name,m.strength,m.dosage_form,m.unit_of_measure)=(s.name,s.strength,s.dosage_form,s.unit_of_measure)
      WHERE s.n>2 AND m.id<>s.id) THEN
    RAISE EXCEPTION 'A requested simulated formulation already exists under a different catalogue ID';
  END IF;
  INSERT INTO public.medicines(id,name,generic_name,active_ingredient,strength,dosage_form,unit_of_measure)
  SELECT id,name,generic_name,active_ingredient,strength,dosage_form,unit_of_measure FROM _mn_medicine WHERE n>2
  ON CONFLICT(id) DO NOTHING;

  CREATE TEMP TABLE _mn_batch(n int PRIMARY KEY,facility_no int,medicine_no int,quantity int,threshold int,expiry_days int,age_hours int) ON COMMIT DROP;
  INSERT INTO _mn_batch VALUES
  (1,1,1,120,25,365,1),(2,1,2,36,10,220,2),(3,1,3,24,5,180,1),(4,1,9,12,3,200,3),
  (5,2,2,40,10,180,2),(6,2,5,45,12,150,3),(7,2,8,28,8,260,1),(8,2,4,12,5,210,4),
  (9,3,1,8,10,200,2),(10,3,5,5,10,220,2),(11,3,6,7,10,240,5),(12,3,3,6,10,180,3),
  (13,4,1,4,10,180,2),(14,4,7,3,10,200,2),(15,4,8,5,12,190,4),(16,4,2,9,12,160,5),
  (17,5,1,35,10,20,4),(18,5,5,30,10,12,3),(19,5,4,20,8,25,2),(20,5,9,18,5,30,3),
  (21,6,1,100,10,-1,1),(22,6,5,20,5,-4,2),(23,6,7,15,5,-2,3),(24,6,3,9,5,-1,2),
  (25,7,1,90,15,300,240),(26,7,2,70,15,300,240),(27,7,8,30,8,250,200),(28,7,6,25,8,250,190),
  (29,8,1,6,5,220,1),(30,8,1,8,5,220,24),(31,8,4,10,5,220,3),(32,8,7,14,5,180,5),(33,8,3,8,5,190,2),
  (34,9,5,8,4,150,2),(35,9,6,20,5,220,1),(36,9,3,12,4,180,4),(37,9,8,6,4,170,3),
  (38,10,2,55,15,300,2),(39,10,4,32,10,240,4),(40,10,6,40,10,180,1),(41,10,9,25,8,260,5),
  (42,11,1,65,15,280,2),(43,11,5,22,8,200,4),(44,11,7,18,5,230,1),(45,11,8,35,10,300,3),
  (46,12,2,6,10,180,2),(47,12,4,7,10,180,3),(48,12,6,5,10,200,2),(49,12,9,9,12,220,4),
  (50,13,1,28,8,240,3),(51,13,3,16,5,190,1),(52,13,5,24,8,230,2),(53,13,8,14,5,200,4),
  (54,14,2,48,10,260,220),(55,14,4,26,8,250,220),(56,14,7,20,5,210,220),(57,14,9,16,5,230,220),
  (58,15,1,18,5,18,2),(59,15,3,15,5,22,3),(60,15,6,30,8,14,1),(61,15,8,12,5,28,4),
  (62,16,2,60,12,-3,1),(63,16,4,25,8,-10,2),(64,16,5,14,5,-2,2),(65,16,9,20,5,-1,3),
  (66,17,1,42,10,300,1),(67,17,2,18,5,220,3),(68,17,3,20,5,180,2),(69,17,7,26,8,250,4),
  (70,18,5,4,10,190,2),(71,18,6,8,12,200,3),(72,18,8,7,10,220,1),(73,18,4,5,8,180,5),
  (74,19,1,6,5,250,1),(75,19,1,8,5,250,48),(76,19,2,22,5,210,2),(77,19,7,11,5,200,3),(78,19,9,32,8,280,1),
  (79,20,1,50,10,210,2),(80,20,2,24,8,240,4),(81,20,3,12,5,220,1),(82,20,8,17,6,200,3);

  IF EXISTS (SELECT 1 FROM _mn_batch s JOIN _mn_facility f ON f.n=s.facility_no
      JOIN _mn_medicine med ON med.n=s.medicine_no JOIN public.inventory_batches b
      ON b.facility_id=f.id AND b.medicine_id=med.id AND b.batch_number='SIM-H'||to_char(s.facility_no,'FM00')||'-B'||lpad(s.n::text,3,'0')
      WHERE b.id IS DISTINCT FROM ('a9f45f20-a061-4fe1-9b34-'||lpad(s.n::text,12,'0'))::uuid) THEN
    RAISE EXCEPTION 'A simulated batch number is already used by a different inventory row';
  END IF;
  IF EXISTS (SELECT 1 FROM _mn_batch s JOIN public.inventory_batches b
      ON b.id=('a9f45f20-a061-4fe1-9b34-'||lpad(s.n::text,12,'0'))::uuid
      WHERE (b.facility_id,b.medicine_id,b.batch_number,b.quantity_on_hand,b.quantity_reserved,b.low_stock_threshold)
        IS DISTINCT FROM ((SELECT id FROM _mn_facility WHERE n=s.facility_no),
          (SELECT id FROM _mn_medicine WHERE n=s.medicine_no),
          'SIM-H'||to_char(s.facility_no,'FM00')||'-B'||lpad(s.n::text,3,'0'),s.quantity,0,s.threshold)) THEN
    RAISE EXCEPTION 'A deterministic demo batch ID is occupied by conflicting or operated stock; refusing to overwrite';
  END IF;
  INSERT INTO public.inventory_batches(id,facility_id,medicine_id,batch_number,quantity_on_hand,quantity_reserved,
      low_stock_threshold,expiry_date,last_updated_at)
  SELECT ('a9f45f20-a061-4fe1-9b34-'||lpad(s.n::text,12,'0'))::uuid,f.id,med.id,
      'SIM-H'||to_char(s.facility_no,'FM00')||'-B'||lpad(s.n::text,3,'0'),s.quantity,0,s.threshold,
      current_date+s.expiry_days,now()-make_interval(hours=>s.age_hours)
  FROM _mn_batch s JOIN _mn_facility f ON f.n=s.facility_no JOIN _mn_medicine med ON med.n=s.medicine_no
  ON CONFLICT(id) DO NOTHING;
  IF EXISTS (SELECT 1 FROM _mn_batch s JOIN public.inventory_batches b
      ON b.id=('a9f45f20-a061-4fe1-9b34-'||lpad(s.n::text,12,'0'))::uuid
      WHERE (s.expiry_days < 0 AND b.expiry_date >= current_date)
         OR (s.expiry_days BETWEEN 0 AND 30 AND (b.expiry_date < current_date OR b.expiry_date > current_date+30))
         OR (s.expiry_days > 30 AND b.expiry_date <= current_date+30)
         OR (s.age_hours < 168 AND b.last_updated_at <= now()-interval '168 hours')
         OR (s.age_hours >= 168 AND b.last_updated_at > now()-interval '168 hours')) THEN
    RAISE EXCEPTION 'Existing deterministic batch no longer represents its recorded expiry/freshness scenario';
  END IF;
  INSERT INTO public.stock_movements(id,facility_id,inventory_batch_id,medicine_id,movement_type,quantity,performed_by,notes)
  SELECT ('c9f45f20-a061-4fe1-9b34-'||lpad(s.n::text,12,'0'))::uuid,f.id,
    ('a9f45f20-a061-4fe1-9b34-'||lpad(s.n::text,12,'0'))::uuid,med.id,'INITIAL_STOCK',s.quantity,v_actor,
    'DEMO PROJECT ONLY; SIMULATED stock; fictional, unverified, not a physical count.'
  FROM _mn_batch s JOIN _mn_facility f ON f.n=s.facility_no JOIN _mn_medicine med ON med.n=s.medicine_no
  ON CONFLICT(id) DO NOTHING;
  IF EXISTS (SELECT 1 FROM _mn_batch s JOIN public.stock_movements m
      ON m.id=('c9f45f20-a061-4fe1-9b34-'||lpad(s.n::text,12,'0'))::uuid
      WHERE (m.facility_id,m.inventory_batch_id,m.medicine_id,m.movement_type,m.quantity,m.performed_by,m.notes)
        IS DISTINCT FROM ((SELECT id FROM _mn_facility WHERE n=s.facility_no),
          ('a9f45f20-a061-4fe1-9b34-'||lpad(s.n::text,12,'0'))::uuid,
          (SELECT id FROM _mn_medicine WHERE n=s.medicine_no),'INITIAL_STOCK',s.quantity,v_actor,
          'DEMO PROJECT ONLY; SIMULATED stock; fictional, unverified, not a physical count.') ) THEN
    RAISE EXCEPTION 'A deterministic stock movement ID conflicts with existing audit history';
  END IF;
  SELECT count(*) INTO v_expected FROM _mn_batch s JOIN _mn_facility f ON f.n=s.facility_no
    JOIN public.inventory_batches b ON b.id=('a9f45f20-a061-4fe1-9b34-'||lpad(s.n::text,12,'0'))::uuid
    JOIN public.stock_movements m ON m.id=('c9f45f20-a061-4fe1-9b34-'||lpad(s.n::text,12,'0'))::uuid
    WHERE b.facility_id=f.id AND b.quantity_reserved=0 AND m.movement_type='INITIAL_STOCK'
      AND m.quantity=b.quantity_on_hand AND m.notes LIKE 'DEMO PROJECT ONLY; SIMULATED stock;%';
  IF v_expected<>82 THEN RAISE EXCEPTION 'Expected 82 matching simulated batches and initial-stock audit movements, found %',v_expected; END IF;
  IF EXISTS (SELECT 1 FROM _mn_facility f JOIN public.profiles p ON p.facility_id=f.id)
     OR EXISTS (SELECT 1 FROM _mn_facility f JOIN public.supply_requests r ON r.requesting_facility_id=f.id OR r.supplying_facility_id=f.id)
     OR EXISTS (SELECT 1 FROM _mn_facility f JOIN public.request_reservations r ON r.supplying_facility_id=f.id) THEN
    RAISE EXCEPTION 'Seed must not create hospital profiles, requests or reservations';
  END IF;
END $$;
COMMIT;
